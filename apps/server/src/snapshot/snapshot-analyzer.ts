import type { CommitInfo, DiffContentKind, DivergenceCommit, SnapshotFileDiff } from '@om/shared';
import { createLimiter } from '../compare/limit.ts';
import { CompareInputError, NotFoundError, errorMessage } from '../errors.ts';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import type { Rename } from './annotate-renames.ts';
import { parseBlamePorcelain } from './blame-parse.ts';
import { lineRanges, parseHunks, wholeFileHunk, type ParsedHunks } from './diff-parse.ts';
import { LruCache } from './lru-cache.ts';
import { objectView, type ObjectView } from './object-view.ts';

/** Size limits for {@link SnapshotAnalyzer}. */
export type AnalyzerLimits = {
  /** Text files larger than this get `content: 'too-large'`. */
  maxTextBytes: number;
  /** Hunk lines returned per file before `truncated` is set. */
  maxDiffLines: number;
};

/** Same heuristic as git and the Files view: a NUL byte in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;

/** More `-L` ranges than this and blame runs on the whole file instead (command-line length). */
const MAX_BLAME_RANGES = 400;

type TreeEntry = { oid: string; size: number };

type SideContent =
  { kind: 'text'; oid: string; text: string } | { kind: 'binary' | 'too-large'; oid: string };

/**
 * Git-backed analysis of two snapshots: renames, one file's diff with the commits that
 * currently account for each changed line, and ancestry. Results are cached by commit SHA,
 * so repeated navigation is instant and never stale.
 */
export class SnapshotAnalyzer {
  readonly #git: GitService;
  readonly #limits: AnalyzerLimits;
  readonly #diffs = new LruCache<SnapshotFileDiff>(500);
  readonly #ancestry = new LruCache<boolean | null>(50_000);
  readonly #limit = createLimiter(8);

  constructor(git: GitService, limits: AnalyzerLimits) {
    this.#git = git;
    this.#limits = limits;
  }

  /**
   * Whether `commit` is reachable from `tip` (`git merge-base --is-ancestor`), or null when
   * git can't tell (e.g. an object is missing).
   */
  async isAncestor(
    view: ObjectView,
    commit: string,
    tip: string,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    if (commit === tip) return true;
    const key = `${commit}>${tip}`;
    const isCachedAncestor = this.#ancestry.get(key);
    if (isCachedAncestor !== undefined) return isCachedAncestor;
    const isReachable = await this.#limit(async () => {
      try {
        const { exitCode } = await this.#git.run(
          view.cwd,
          ['merge-base', '--is-ancestor', commit, tip],
          { env: view.env, okExitCodes: [0, 1], ...(signal ? { signal } : {}) },
        );
        return exitCode === 0;
      } catch (err) {
        if (signal?.aborted === true) throw err;
        return null;
      }
    });
    if (isReachable !== null) this.#ancestry.set(key, isReachable);
    return isReachable;
  }

  /** Files git detects as renamed from `left` to `right` (`git diff -M`). */
  async renames(left: ResolvedSnapshot, right: ResolvedSnapshot): Promise<Rename[]> {
    const view = objectView(left.repoDir, right.repoDir);
    const { stdout } = await this.#git.run(
      view.cwd,
      ['diff', '--name-status', '-z', '-M', '--diff-filter=R', left.commit, right.commit, '--'],
      { env: view.env },
    );
    const tokens = stdout.split('\0');
    const renames: Rename[] = [];
    for (let i = 0; i + 2 < tokens.length; i += 3) {
      const status = tokens[i] ?? '';
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (status.startsWith('R') && from !== undefined && to !== undefined) {
        renames.push({ from, to, similarity: Number(status.slice(1)) || 0 });
      }
    }
    return renames;
  }

  /**
   * One file between two snapshots, read Base → Target: git's hunks, plus for every changed
   * line the commit `git blame` attributes it to in that line's own history (removed lines in
   * Base's, added lines in Target's), and whether each such commit is reachable from either side.
   */
  async fileDiff(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    paths: { leftPath?: string | undefined; rightPath?: string | undefined; isFullFile?: boolean },
    signal?: AbortSignal,
  ): Promise<SnapshotFileDiff> {
    const { leftPath, rightPath, isFullFile = false } = paths;
    const key = [left.commit, right.commit, leftPath ?? '', rightPath ?? '', isFullFile].join('\0');
    const cached = this.#diffs.get(key);
    if (cached) return cached;

    const opt = signal ? { signal } : {};
    const [l, r] = await Promise.all([
      leftPath === undefined ? undefined : this.#readSide(left, leftPath, opt),
      rightPath === undefined ? undefined : this.#readSide(right, rightPath, opt),
    ]);
    const result: SnapshotFileDiff = {
      leftCommit: left.commit,
      rightCommit: right.commit,
      ...(leftPath === undefined ? {} : { leftPath }),
      ...(rightPath === undefined ? {} : { rightPath }),
      content: 'text',
      hunks: [],
      commits: [],
    };

    const kind = contentKind(l, r);
    result.content = kind;
    if (kind === 'text') {
      const parsed = await this.#hunks(left, right, l, r, isFullFile, opt);
      result.hunks = parsed.hunks;
      if (parsed.isTruncated) result.truncated = true;
      await this.#attribute(result, left, right, leftPath, rightPath, opt);
    }
    this.#diffs.set(key, result);
    return result;
  }

  async #readSide(
    snapshot: ResolvedSnapshot,
    filePath: string,
    opt: { signal?: AbortSignal },
  ): Promise<SideContent> {
    const entry = await this.#entry(snapshot, filePath, opt);
    if (entry.size > this.#limits.maxTextBytes) {
      const head = await this.#blob(snapshot, entry.oid, opt);
      return {
        kind: head.subarray(0, BINARY_SNIFF_BYTES).includes(0) ? 'binary' : 'too-large',
        oid: entry.oid,
      };
    }
    const bytes = await this.#blob(snapshot, entry.oid, opt);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0))
      return { kind: 'binary', oid: entry.oid };
    return { kind: 'text', oid: entry.oid, text: bytes.toString('utf8') };
  }

  async #entry(
    snapshot: ResolvedSnapshot,
    filePath: string,
    opt: { signal?: AbortSignal },
  ): Promise<TreeEntry> {
    const { stdout } = await this.#git.run(
      snapshot.repoDir,
      ['ls-tree', '-z', '-l', snapshot.commit, '--', filePath],
      opt,
    );
    const record = stdout.split('\0').find((r) => r.endsWith(`\t${filePath}`));
    const match = record === undefined ? null : /^(\d+) (\S+) (\S+) +(\S+)\t/.exec(record);
    if (!match) throw new NotFoundError(`${filePath} does not exist in ${snapshot.label}`);
    if (match[2] !== 'blob') {
      throw new CompareInputError(
        `${filePath} is not a file in ${snapshot.label} (${match[2] ?? ''})`,
      );
    }
    return { oid: match[3] ?? '', size: Number(match[4]) };
  }

  async #blob(
    snapshot: ResolvedSnapshot,
    oid: string,
    opt: { signal?: AbortSignal },
  ): Promise<Buffer> {
    const { stdout } = await this.#git.runBuffer(snapshot.repoDir, ['cat-file', 'blob', oid], {
      ...opt,
      maxBytes: Math.max(this.#limits.maxTextBytes, BINARY_SNIFF_BYTES) * 4,
    });
    return stdout;
  }

  async #hunks(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    l: SideContent | undefined,
    r: SideContent | undefined,
    isFullFile: boolean,
    opt: { signal?: AbortSignal },
  ): Promise<ParsedHunks> {
    const max = this.#limits.maxDiffLines;
    if (l?.kind === 'text' && r?.kind === 'text') {
      const view = objectView(left.repoDir, right.repoDir);
      const context = isFullFile ? Math.max(countLines(l.text), countLines(r.text)) + 1 : 3;
      const { stdout } = await this.#git.run(
        view.cwd,
        ['diff', `-U${context}`, '--no-color', '--no-ext-diff', '--no-textconv', l.oid, r.oid],
        { env: view.env, okExitCodes: [0, 1], ...opt },
      );
      return parseHunks(stdout, max);
    }
    if (l?.kind === 'text') return wholeFileHunk(l.text, 'left', max);
    if (r?.kind === 'text') return wholeFileHunk(r.text, 'right', max);
    return { hunks: [], isTruncated: false };
  }

  async #attribute(
    result: SnapshotFileDiff,
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    leftPath: string | undefined,
    rightPath: string | undefined,
    opt: { signal?: AbortSignal },
  ): Promise<void> {
    const removed = result.hunks.flatMap((h) =>
      h.lines.flatMap((x) =>
        x.kind === 'removed' && x.leftLine !== undefined ? [x.leftLine] : [],
      ),
    );
    const added = result.hunks.flatMap((h) =>
      h.lines.flatMap((x) =>
        x.kind === 'added' && x.rightLine !== undefined ? [x.rightLine] : [],
      ),
    );
    const notes: string[] = [];
    const blameSide = async (
      snapshot: ResolvedSnapshot,
      filePath: string | undefined,
      lines: number[],
    ) => {
      if (filePath === undefined || lines.length === 0) return undefined;
      try {
        return await this.#blame(snapshot, filePath, lines, opt);
      } catch (err) {
        if (opt.signal?.aborted === true) throw err;
        notes.push(`git blame failed in ${snapshot.label}: ${errorMessage(err)}`);
        return undefined;
      }
    };
    const [leftBlame, rightBlame] = await Promise.all([
      blameSide(left, leftPath, removed),
      blameSide(right, rightPath, added),
    ]);

    const infos = new Map<string, CommitInfo>();
    const sides = new Map<string, { isLeft: boolean; isRight: boolean }>();
    for (const hunk of result.hunks) {
      for (const line of hunk.lines) {
        const isLeft = line.kind === 'removed';
        const blame = isLeft ? leftBlame : line.kind === 'added' ? rightBlame : undefined;
        const number = isLeft ? line.leftLine : line.rightLine;
        const sha = blame && number !== undefined ? blame.lines.get(number) : undefined;
        const info = sha === undefined ? undefined : blame?.commits.get(sha);
        if (sha === undefined || !info) continue;
        line.commit = sha;
        infos.set(sha, info);
        const seen = sides.get(sha) ?? { isLeft: false, isRight: false };
        sides.set(sha, { isLeft: seen.isLeft || isLeft, isRight: seen.isRight || !isLeft });
      }
    }

    const view = objectView(left.repoDir, right.repoDir);
    result.commits = await Promise.all(
      [...infos.values()].map(async (info): Promise<DivergenceCommit> => {
        const seen = sides.get(info.sha) ?? { isLeft: false, isRight: false };
        const [isInLeft, isInRight] = await Promise.all([
          seen.isLeft ? true : this.isAncestor(view, info.sha, left.commit, opt.signal),
          seen.isRight ? true : this.isAncestor(view, info.sha, right.commit, opt.signal),
        ]);
        return { ...info, inLeft: isInLeft, inRight: isInRight };
      }),
    );
    result.commits.sort(
      (a, b) => b.commitDate.localeCompare(a.commitDate) || a.sha.localeCompare(b.sha),
    );
    if (notes.length > 0) result.attributionNote = notes.join('\n');
  }

  async #blame(
    snapshot: ResolvedSnapshot,
    filePath: string,
    lines: number[],
    opt: { signal?: AbortSignal },
  ) {
    let ranges = lineRanges(lines);
    for (let gap = 4; ranges.length > MAX_BLAME_RANGES && gap < 1 << 20; gap *= 4) {
      ranges = lineRanges(lines, gap);
    }
    const args = ['blame', '--porcelain'];
    if (ranges.length <= MAX_BLAME_RANGES) {
      for (const [start, end] of ranges) args.push('-L', `${start},${end}`);
    }
    args.push(snapshot.commit, '--', filePath);
    // One request for the file's history instead of one lazy fetch per version.
    await this.#git.prefetchMissing(snapshot.repoDir, [snapshot.commit], [filePath], opt);
    try {
      return parseBlamePorcelain((await this.#git.run(snapshot.repoDir, args, opt)).stdout);
    } catch (err) {
      if (opt.signal?.aborted === true) throw err;
      // Another process may have been adding objects to the clone at that moment: retry once.
      return parseBlamePorcelain((await this.#git.run(snapshot.repoDir, args, opt)).stdout);
    }
  }
}

function countLines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === '\n') n++;
  return n;
}

function contentKind(l: SideContent | undefined, r: SideContent | undefined): DiffContentKind {
  if (l !== undefined && l.oid === r?.oid) return 'identical';
  if (l?.kind === 'binary' || r?.kind === 'binary') return 'binary';
  if (l?.kind === 'too-large' || r?.kind === 'too-large') return 'too-large';
  return 'text';
}
