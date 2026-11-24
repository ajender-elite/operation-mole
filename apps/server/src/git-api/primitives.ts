import type { CommitInfo, FolderComparison, GitTreeEntry, SnapshotFileDiff } from '@om/shared';
import { compareTreeLeaves } from '../compare/git-trees.ts';
import { createLimiter } from '../compare/limit.ts';
import { CompareInputError, NotFoundError } from '../errors.ts';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import { parseBlameLines } from '../snapshot/blame-parse.ts';
import { annotateRenames, type Rename } from '../snapshot/annotate-renames.ts';
import { lineRanges } from '../snapshot/diff-parse.ts';
import { objectView, withScratchObjects, type ObjectView } from '../snapshot/object-view.ts';
import type { CommitRecord } from '../snapshot/commit-records.ts';
import type { SnapshotAnalyzer } from '../snapshot/snapshot-analyzer.ts';
import { parseMergeTree } from './merge-tree-parse.ts';
import { COMMIT_FORMAT, parseMarkedCommitRecords } from '../snapshot/commit-records.ts';
import { listLeaves, prefetchTree, readLinkTargets } from './trees.ts';

/** Conflicted files whose merged text is returned, and the largest file read. */
const MAX_CONFLICT_FILES = 10;
const MAX_CONFLICT_BYTES = 8 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

/** What a merge produces: whether it is clean, what it changes, and what conflicts. */
export type GitMergeOutput = {
  base: string;
  isClean: boolean;
  conflictedPaths: string[];
  conflictedFiles: Array<{ path: string; text: string | null }>;
  changedPaths: string[];
  messages: string[];
};

export type BlameOutput = {
  lines: Array<{
    line: number;
    commit: string;
    origLine: number;
    origPath?: string | undefined;
    boundary: boolean;
  }>;
  commits: CommitInfo[];
};

export type TreesOutput = {
  entries: GitTreeEntry[];
  renames: Rename[];
  folder: FolderComparison;
};

/** Ordinary code-point order, so paths sort the same on every machine. */
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The git-like primitives the API exposes: each one answers one question git can answer about
 * commits and trees, and leaves the screens built from them to the frontend. Analysis only: nothing
 * here writes a ref, an index or a worktree.
 */
export class GitPrimitives {
  readonly #git: GitService;
  readonly #snapshots: SnapshotAnalyzer;
  readonly #scratchDir: string;
  readonly #limit = createLimiter(4);

  constructor(git: GitService, snapshots: SnapshotAnalyzer, options: { scratchDir: string }) {
    this.#git = git;
    this.#snapshots = snapshots;
    this.#scratchDir = options.scratchDir;
  }

  /** The best common ancestor of two commits (`git merge-base`), or null when they share none. */
  async mergeBase(
    a: ResolvedSnapshot,
    b: ResolvedSnapshot,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const view = objectView(a.repoDir, b.repoDir);
    const { stdout, exitCode } = await this.#git.run(view.cwd, ['merge-base', a.commit, b.commit], {
      env: view.env,
      okExitCodes: [0, 1],
      ...(signal ? { signal } : {}),
    });
    return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : null;
  }

  /**
   * For each commit, whether it is in the history of `tip` (true, false, or null when git cannot
   * tell, for example for a commit that is not in the tip's repository). Commits are looked up in
   * the tip's own repository.
   */
  ancestry(
    tip: ResolvedSnapshot,
    commits: readonly string[],
    signal?: AbortSignal,
  ): Promise<Array<{ commit: string; isAncestor: boolean | null }>> {
    const view = objectView(tip.repoDir);
    return Promise.all(
      commits.map(async (commit) => ({
        commit,
        isAncestor: await this.#snapshots.isAncestor(
          tip.cacheScope,
          view,
          commit,
          tip.commit,
          signal,
        ),
      })),
    );
  }

  /**
   * Who last changed each line of a file at a commit (`git blame --porcelain`), all lines or the
   * given ones. A line's origin is that commit's line and path, so renames are visible.
   */
  async blame(
    snapshot: ResolvedSnapshot,
    filePath: string,
    lines: readonly number[] | undefined,
    signal?: AbortSignal,
  ): Promise<BlameOutput> {
    const opt = signal ? { signal } : {};
    await this.#requireFile(snapshot, filePath, opt);
    const args = ['blame', '--porcelain'];
    if (lines !== undefined) {
      for (const [start, end] of lineRanges(lines)) args.push('-L', `${start},${end}`);
    }
    args.push(snapshot.commit, '--', filePath);
    // One request for the file's history instead of one lazy fetch per version.
    await this.#git.prefetchMissing(snapshot.repoDir, [snapshot.commit], [filePath], {
      ...opt,
      remote: snapshot.remote,
    });
    const { stdout } = await this.#git.run(snapshot.repoDir, args, opt);
    const parsed = parseBlameLines(stdout);
    return {
      lines: parsed.lines.map((line) => ({
        line: line.line,
        commit: line.commit,
        origLine: line.origLine,
        // Only a different path is news: the common case (no rename) is left out.
        ...(line.origPath === undefined || line.origPath === filePath
          ? {}
          : { origPath: line.origPath }),
        boundary: line.boundary,
      })),
      commits: parsed.commits,
    };
  }

  /**
   * Hunks for each file pair between two commits, without attribution (the diff only). Each pair
   * is read Left → Right: `leftPath` in `left`, `rightPath` in `right`.
   */
  diff(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    files: ReadonlyArray<{ leftPath?: string | undefined; rightPath?: string | undefined }>,
    isFullFile: boolean,
    signal?: AbortSignal,
  ): Promise<SnapshotFileDiff[]> {
    return Promise.all(
      files.map((file) =>
        this.#limit(() =>
          this.#snapshots.fileDiff(
            left,
            right,
            {
              leftPath: file.leftPath,
              rightPath: file.rightPath,
              isFullFile,
            },
            signal,
          ),
        ),
      ),
    );
  }

  /**
   * Merges `theirs` into `ours` against `base` (their merge base when not given), in a scratch object
   * store that is removed afterwards: no ref, index or worktree is touched. A clean result means git
   * could merge the two; a conflict lists the paths. Histories with no common ancestor are refused.
   */
  async mergeTree(
    ours: ResolvedSnapshot,
    theirs: ResolvedSnapshot,
    base: ResolvedSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<GitMergeOutput> {
    const opt = signal ? { signal } : {};
    const mergeBase = base?.commit ?? (await this.mergeBase(ours, theirs, signal));
    if (mergeBase === null) {
      throw new CompareInputError('These two histories have no common ancestor to merge from');
    }
    const view = objectView(ours.repoDir, theirs.repoDir);
    return await withScratchObjects(view, this.#scratchDir, async (scratch) => {
      const merge = await this.#git.run(
        scratch.cwd,
        [
          'merge-tree',
          '--write-tree',
          '-z',
          '--name-only',
          `--merge-base=${mergeBase}`,
          ours.commit,
          theirs.commit,
        ],
        { env: scratch.env, okExitCodes: [0, 1], ...opt },
      );
      const { tree, conflicted, messages } = parseMergeTree(merge.stdout);
      const changed = await this.#git.run(
        scratch.cwd,
        ['diff-tree', '-r', '-z', '--name-only', '--no-renames', ours.commit, tree, '--'],
        { env: scratch.env, ...opt },
      );
      const conflictedFiles: Array<{ path: string; text: string | null }> = [];
      for (const path of conflicted.slice(0, MAX_CONFLICT_FILES)) {
        const file = await this.#readMerged(scratch, tree, path, opt);
        if (file !== undefined) conflictedFiles.push({ path, text: file });
      }
      return {
        base: mergeBase,
        isClean: merge.exitCode === 0,
        conflictedPaths: conflicted,
        conflictedFiles,
        changedPaths: changed.stdout.split('\0').filter((p) => p !== ''),
        messages,
      };
    });
  }

  /**
   * The commits on each side of `left...right` (after `exclude`, when given), each marked as on one
   * side, or as making the same change as a commit on the other side (`--cherry-mark`). Newest first.
   */
  async patchEquivalents(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    exclude: ResolvedSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<Array<{ commit: CommitRecord; mark: 'left' | 'right' | 'equivalent' }>> {
    const opt = signal ? { signal } : {};
    const view = objectView(left.repoDir, right.repoDir);
    const args = [
      'log',
      '-z',
      '--left-right',
      '--cherry-mark',
      '--no-merges',
      `--format=%m%x1f${COMMIT_FORMAT}`,
      `${left.commit}...${right.commit}`,
    ];
    if (exclude !== undefined) args.push(`^${exclude.commit}`);
    args.push('--');
    const { stdout } = await this.#git.run(view.cwd, args, { env: view.env, ...opt });
    return parseMarkedCommitRecords(stdout).map(({ mark, commit }) => ({
      commit,
      mark: mark === '=' ? 'equivalent' : mark === '<' ? 'left' : 'right',
    }));
  }

  /** The merged text of one conflicted file (with its conflict markers), or undefined when it is absent or binary. */
  async #readMerged(
    scratch: ObjectView,
    tree: string,
    path: string,
    opt: { signal?: AbortSignal },
  ): Promise<string | null | undefined> {
    try {
      const { stdout } = await this.#git.runBuffer(
        scratch.cwd,
        ['cat-file', 'blob', `${tree}:${path}`],
        {
          env: scratch.env,
          maxBytes: MAX_CONFLICT_BYTES,
          ...opt,
        },
      );
      return stdout.subarray(0, BINARY_SNIFF_BYTES).includes(0) ? null : stdout.toString('utf8');
    } catch (err) {
      if (opt.signal?.aborted === true) throw err;
      // Modify/delete conflicts have no file in the result; the messages say so.
      return undefined;
    }
  }

  /**
   * Every file of two trees with its status (identical, modified, only on one side), and the renames
   * git detects between them. Folders are not listed: they follow from the files under them.
   * Compares object ids, so nothing is checked out.
   */
  async compareTrees(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    paths: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<TreesOutput> {
    const opt = signal ? { signal } : {};
    await prefetchTree(this.#git, left, opt);
    await prefetchTree(this.#git, right, opt);
    const [l, r] = await Promise.all([
      listLeaves(this.#git, left, paths, opt),
      listLeaves(this.#git, right, paths, opt),
    ]);
    const names = [...new Set([...l.keys(), ...r.keys()])].sort(byPath);
    const entries = names.map((path): GitTreeEntry => {
      const a = l.get(path);
      const b = r.get(path);
      if (a !== undefined && b !== undefined) {
        const isSame = a.oid === b.oid && a.kind === b.kind;
        return { path, status: isSame ? 'identical' : 'modified', left: a, right: b };
      }
      if (a !== undefined) return { path, status: 'only-left', left: a };
      return { path, status: 'only-right', right: b };
    });
    const shown = new Set(names);
    const renames = (await this.#snapshots.renames(left, right)).filter(
      (rename) => paths === undefined || shown.has(rename.from) || shown.has(rename.to),
    );
    // The same leaves, as the folder tree: what Folder Compare shows, renames marked on it.
    const linkTargets = new Map([
      ...(await readLinkTargets(this.#git, left, l, opt)),
      ...(await readLinkTargets(this.#git, right, r, opt)),
    ]);
    const folder = compareTreeLeaves({
      left: l,
      right: r,
      linkTargets,
      leftLabel: left.label,
      rightLabel: right.label,
    });
    annotateRenames(folder.root, renames);
    return {
      entries,
      renames,
      folder: {
        leftLabel: folder.leftLabel,
        rightLabel: folder.rightLabel,
        root: folder.root,
        summary: folder.summary,
        leftSnapshot: { commit: left.commit, ref: left.ref },
        rightSnapshot: { commit: right.commit, ref: right.ref },
      },
    };
  }

  /** Checks that `filePath` is a file at this commit (a folder, or nothing, is not blame-able). */
  async #requireFile(
    snapshot: ResolvedSnapshot,
    filePath: string,
    opt: { signal?: AbortSignal },
  ): Promise<void> {
    const { stdout } = await this.#git.run(
      snapshot.repoDir,
      ['ls-tree', '-z', snapshot.commit, '--', filePath],
      opt,
    );
    const record = stdout.split('\0').find((r) => r.endsWith(`\t${filePath}`));
    if (record === undefined)
      throw new NotFoundError(`${filePath} does not exist in ${snapshot.label}`);
    if (!/^\d+ blob /.test(record)) {
      throw new CompareInputError(`${filePath} is not a file in ${snapshot.label}`);
    }
  }
}
