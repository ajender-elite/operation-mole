import { type DiffContentKind, type SnapshotFileDiff, SnapshotFileDiffSchema } from '@om/shared';
import { z } from 'zod';
import {
  type AnalysisCache,
  type CacheScope,
  TieredAnalysisCache,
} from '../cache/analysis-cache.ts';
import { MemoryCacheStorage } from '../cache/memory-cache-storage.ts';
import { createLimiter } from '../compare/limit.ts';
import { CompareInputError, NotFoundError } from '../errors.ts';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import type { Rename } from './annotate-renames.ts';
import { parseHunks, wholeFileHunk, type ParsedHunks } from './diff-parse.ts';
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
  readonly #cache: AnalysisCache;
  readonly #limit = createLimiter(8);

  constructor(
    git: GitService,
    limits: AnalyzerLimits,
    cache: AnalysisCache = new TieredAnalysisCache(new MemoryCacheStorage()),
  ) {
    this.#git = git;
    this.#limits = limits;
    this.#cache = cache;
  }

  /**
   * Whether `commit` is reachable from `tip` (`git merge-base --is-ancestor`), or null when
   * git can't tell (e.g. an object is missing).
   */
  async isAncestor(
    scope: CacheScope,
    view: ObjectView,
    commit: string,
    tip: string,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    if (commit === tip) return true;
    return await this.#cache.remember(
      scope,
      `ancestor|${commit}|${tip}`,
      z.boolean().nullable(),
      () =>
        this.#limit(async () => {
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
        }),
      // null means git could not tell (an object is missing): ask again next time.
      (isReachable) => isReachable !== null,
    );
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
   * One file between two snapshots, read Left → Right: git's hunks. No attribution here: which commit
   * accounts for a line is a question the caller asks git blame (`blame`) about, on the side it wants.
   */
  async fileDiff(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    paths: {
      leftPath?: string | undefined;
      rightPath?: string | undefined;
      isFullFile?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<SnapshotFileDiff> {
    const { leftPath, rightPath, isFullFile = false } = paths;
    const key = JSON.stringify([
      'file-diff',
      left.commit,
      right.commit,
      leftPath ?? '',
      rightPath ?? '',
      isFullFile,
    ]);
    return await this.#cache.remember(left.cacheScope, key, SnapshotFileDiffSchema, () =>
      this.#computeFileDiff(left, right, { leftPath, rightPath, isFullFile }, signal),
    );
  }

  async #computeFileDiff(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    paths: {
      leftPath: string | undefined;
      rightPath: string | undefined;
      isFullFile: boolean;
    },
    signal?: AbortSignal,
  ): Promise<SnapshotFileDiff> {
    const { leftPath, rightPath, isFullFile } = paths;
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
    }
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
