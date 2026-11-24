import {
  type CommitInfo,
  type GitCherryPick,
  type FolderComparison,
  type GitContains,
  type GitFile,
  type GitFiles,
  type GitGrep,
  type GitPatchIds,
  type GitRefs,
  type GitTree,
  type GitTreeEntry,
  type GitTreeNode,
  type SnapshotFileDiff,
  GitCherryPickSchema,
  GitContainsSchema,
  GitFilesSchema,
  GitGrepSchema,
  GitPatchIdsSchema,
  GitRefsSchema,
  GitTreeSchema,
  GitFileSchema,
} from '@om/shared';
import { z } from 'zod';
import { GitBlameSchema } from '@om/shared';
import { compareTreeLeaves } from '../compare/git-trees.ts';
import { createLimiter } from '../compare/limit.ts';
import { compareNames } from '../compare/sort.ts';
import type { AnalysisCache, CacheScope } from '../cache/analysis-cache.ts';
import { CompareInputError, NotFoundError } from '../errors.ts';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import { parseBlameLines } from '../snapshot/blame-parse.ts';
import { annotateRenames, type Rename } from '../snapshot/annotate-renames.ts';
import { lineRanges } from '../snapshot/diff-parse.ts';
import { objectView, withScratchObjects } from '../snapshot/object-view.ts';
import type { CommitRecord } from '../snapshot/commit-records.ts';
import type { SnapshotAnalyzer } from '../snapshot/snapshot-analyzer.ts';
import { parseMergeTree } from './merge-tree-parse.ts';
import { COMMIT_FORMAT, parseMarkedCommitRecords } from '../snapshot/commit-records.ts';
import { listLeaves, prefetchTree, readLinkTargets } from './trees.ts';
import { cherryPickSeries } from './cherry-pick.ts';
import { containingRefs, hasAheadBehind, listRefs } from './refs.ts';
import { grepCommit, type GrepOptions } from './grep.ts';
import { patchIdsOf, MAX_PATCH_ID_COMMITS } from './patch-ids.ts';
import { objectTypes } from './commit-check.ts';
import { readMergedFile } from './merged-file.ts';

/** Conflicted files whose merged text is returned. */
const MAX_CONFLICT_FILES = 10;
/** Cached series results with more conflicted text than this are recomputed rather than stored. */
const MAX_CACHED_CONFLICT_CHARS = 1024 * 1024;
/** Paths a `files` listing keeps (a huge tree is reported as truncated). */
const MAX_FILE_PATHS = 200_000;

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

/** Blame as cached: the same shape as the API response, without the commit and path. */
const BlameOutputSchema = z.object({
  lines: GitBlameSchema.shape.lines,
  commits: GitBlameSchema.shape.commits,
});

export type TreesOutput = {
  entries: GitTreeEntry[];
  renames: Rename[];
  folder: FolderComparison;
};

/** A repo's refs need only its clone and the scope its cache entries belong to. */
export type RepoLocation = { repoDir: string; cacheScope: CacheScope };

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
  readonly #cache: AnalysisCache;
  readonly #limit = createLimiter(4);
  #gitVersion: Promise<string> | undefined;

  constructor(
    git: GitService,
    snapshots: SnapshotAnalyzer,
    options: { scratchDir: string; cache: AnalysisCache },
  ) {
    this.#git = git;
    this.#snapshots = snapshots;
    this.#scratchDir = options.scratchDir;
    this.#cache = options.cache;
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
  blame(
    snapshot: ResolvedSnapshot,
    filePath: string,
    lines: readonly number[] | undefined,
    signal?: AbortSignal,
  ): Promise<BlameOutput> {
    // Blame of one commit never changes, so it is cached by commit, path and the lines asked for.
    return this.#cache.remember(
      snapshot.cacheScope,
      `blame|${snapshot.commit}|${filePath}|${lines?.join(',') ?? ''}`,
      BlameOutputSchema,
      () => this.#blameUncached(snapshot, filePath, lines, signal),
    );
  }

  async #blameUncached(
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
        const file = await readMergedFile(this.#git, scratch, tree, path, opt);
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
   * side, or as making the same change as a commit on the other side (`--cherry-mark`). Newest first,
   * at most `limit` of them (`truncated` says whether more exist).
   */
  async patchEquivalents(
    left: ResolvedSnapshot,
    right: ResolvedSnapshot,
    exclude: ResolvedSnapshot | undefined,
    options: { withBody: boolean; limit: number },
    signal?: AbortSignal,
  ): Promise<{
    commits: Array<{
      commit: CommitRecord & { body?: string | undefined };
      mark: 'left' | 'right' | 'equivalent';
    }>;
    truncated: boolean;
  }> {
    const opt = signal ? { signal } : {};
    const view = objectView(left.repoDir, right.repoDir);
    const args = [
      'log',
      '-z',
      '--left-right',
      '--cherry-mark',
      '--no-merges',
      `--max-count=${options.limit + 1}`,
      `--format=%m%x1f${COMMIT_FORMAT}${options.withBody ? '%x1f%B' : ''}`,
      `${left.commit}...${right.commit}`,
    ];
    if (exclude !== undefined) args.push(`^${exclude.commit}`);
    args.push('--');
    const { stdout } = await this.#git.run(view.cwd, args, { env: view.env, ...opt });
    const parsed = parseMarkedCommitRecords(stdout, options.withBody);
    return {
      commits: parsed.slice(0, options.limit).map(({ mark, commit, body }) => ({
        commit: body === undefined ? commit : { ...commit, body },
        mark: mark === '=' ? 'equivalent' : mark === '<' ? 'left' : 'right',
      })),
      truncated: parsed.length > options.limit,
    };
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

  /**
   * One folder of a commit's tree, one level deep (`git ls-tree`): its folders and files, folders first,
   * each group in Folder Compare's order. Reads object ids only, so no blob is fetched. The root is `''`.
   * Cached by commit and folder (a commit's tree never changes).
   */
  tree(snapshot: ResolvedSnapshot, folder: string, signal?: AbortSignal): Promise<GitTree> {
    return this.#cache.remember(
      snapshot.cacheScope,
      `tree|${snapshot.commit}|${folder}`,
      GitTreeSchema,
      () => this.#listTree(snapshot, folder, signal),
    );
  }

  async #listTree(
    snapshot: ResolvedSnapshot,
    folder: string,
    signal?: AbortSignal,
  ): Promise<GitTree> {
    const opt = signal ? { signal } : {};
    if (folder !== '') {
      // The folder's own entry tells whether it exists and is a tree (a file, or nothing, is refused).
      const { stdout } = await this.#git.run(
        snapshot.repoDir,
        ['ls-tree', '-z', snapshot.commit, '--', folder],
        opt,
      );
      const record = stdout.split('\0').find((r) => r.endsWith(`\t${folder}`));
      if (record === undefined) {
        throw new NotFoundError(`${folder} does not exist in ${snapshot.label}`);
      }
      if (!/^\d+ tree /.test(record)) {
        throw new CompareInputError(`${folder} is not a folder in ${snapshot.label}`);
      }
    }
    // `commit:folder` lists that tree's entries, with names relative to it.
    const target = folder === '' ? snapshot.commit : `${snapshot.commit}:${folder}`;
    const { stdout } = await this.#git.run(snapshot.repoDir, ['ls-tree', '-z', target], opt);
    const entries: GitTreeNode[] = [];
    for (const record of stdout.split('\0')) {
      const match = /^(\d+) (\S+) (\S+)\t([\s\S]*)$/.exec(record);
      if (!match) continue;
      const [, mode = '', type = '', oid = '', name = ''] = match;
      const kind =
        type === 'tree'
          ? 'directory'
          : type === 'commit'
            ? 'submodule'
            : mode === '120000'
              ? 'symlink'
              : 'file';
      entries.push({ name, path: folder === '' ? name : `${folder}/${name}`, kind, oid });
    }
    entries.sort((a, b) => {
      const byKind = Number(b.kind === 'directory') - Number(a.kind === 'directory');
      return byKind || compareNames(a.name, b.name);
    });
    return { commit: snapshot.commit, path: folder, entries };
  }

  /**
   * Every file path of a commit, sorted (`ls-tree -r`, for go-to-file). No blob is read. Cached by
   * commit. A commit with more than the cap is listed up to it, with `truncated` set.
   */
  files(snapshot: ResolvedSnapshot, signal?: AbortSignal): Promise<GitFiles> {
    const opt = signal ? { signal } : {};
    return this.#cache.remember(
      snapshot.cacheScope,
      `files|${snapshot.commit}`,
      GitFilesSchema,
      async () => {
        const { stdout } = await this.#git.run(
          snapshot.repoDir,
          ['ls-tree', '-r', '--name-only', '-z', snapshot.commit],
          opt,
        );
        const all = stdout
          .split('\0')
          .filter((p) => p !== '')
          .sort(byPath);
        return {
          commit: snapshot.commit,
          paths: all.slice(0, MAX_FILE_PATHS),
          truncated: all.length > MAX_FILE_PATHS,
        };
      },
    );
  }

  /** One file of a commit, whole: its text, or why there is none (binary, too large). Cached by blob. */
  async file(snapshot: ResolvedSnapshot, filePath: string, signal?: AbortSignal): Promise<GitFile> {
    const content = await this.#snapshots.readFile(snapshot, filePath, signal);
    return GitFileSchema.parse({ commit: snapshot.commit, path: filePath, ...content });
  }

  /**
   * Lines of a commit that match a query, with context (`git grep`). Cached by commit and query. The
   * tree's blobs are fetched once first, since a blob-less clone would otherwise fetch them one at a time.
   */
  grep(snapshot: ResolvedSnapshot, options: GrepOptions, signal?: AbortSignal): Promise<GitGrep> {
    const opt = signal ? { signal } : {};
    return this.#cache.remember(
      snapshot.cacheScope,
      `grep|${snapshot.commit}|${JSON.stringify(options)}`,
      GitGrepSchema,
      async () => {
        await prefetchTree(this.#git, snapshot, opt);
        const found = await grepCommit(this.#git, snapshot, options, opt);
        return { commit: snapshot.commit, matches: found.matches, truncated: found.truncated };
      },
    );
  }

  /**
   * Every branch and tag of every remote of a repo, newest first within each remote. With `compareTo`,
   * each branch also carries how far it is ahead of and behind that commit (git 2.41 and later; older
   * git gives no counts). Not cached: refs move on every fetch.
   */
  async refs(
    repo: RepoLocation,
    compareTo: ResolvedSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<GitRefs> {
    const opt = signal ? { signal } : {};
    const isCounted = compareTo !== undefined && hasAheadBehind(await this.#version());
    const refs = await listRefs(this.#git, repo.repoDir, {
      ...opt,
      compareTo: compareTo?.commit,
      withAheadBehind: isCounted,
    });
    return GitRefsSchema.parse({
      refs,
      ...(compareTo === undefined
        ? {}
        : { compareTo: { commit: compareTo.commit, ref: compareTo.ref, label: compareTo.label } }),
    });
  }

  /** Every branch and tag (of any remote) whose history includes the commit. Not cached: refs move. */
  async contains(snapshot: ResolvedSnapshot, signal?: AbortSignal): Promise<GitContains> {
    const refs = await containingRefs(
      this.#git,
      snapshot.repoDir,
      snapshot.commit,
      signal ? { signal } : {},
    );
    return GitContainsSchema.parse({ commit: snapshot.commit, refs });
  }

  /**
   * The patch id of each commit (`git patch-id --stable`): equal ids mean the same change. Null for a
   * merge or an empty commit. Cached by the commit list (the commits are SHAs, which never change).
   */
  patchIds(
    snapshot: ResolvedSnapshot,
    commits: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitPatchIds> {
    const opt = signal ? { signal } : {};
    return this.#cache.remember(
      snapshot.cacheScope,
      `patch-ids|${commits.join(',')}`,
      GitPatchIdsSchema,
      async () => {
        if (commits.length > MAX_PATCH_ID_COMMITS) {
          throw new CompareInputError(`At most ${MAX_PATCH_ID_COMMITS} commits at a time`);
        }
        const types = await objectTypes(this.#git, snapshot.repoDir, commits, opt);
        for (const [index, commit] of commits.entries()) {
          if (types[index] === 'missing')
            throw new NotFoundError(`${commit} is not in this repository`);
          if (types[index] !== 'commit') throw new CompareInputError(`${commit} is not a commit`);
        }
        const ids = await patchIdsOf(this.#git, snapshot.repoDir, commits, opt);
        return {
          results: commits.map((commit) => ({ commit, patchId: ids.get(commit) ?? null })),
        };
      },
    );
  }

  /**
   * Would `git cherry-pick <commits…>` onto `onto` succeed, in the order given? See `cherryPickSeries`.
   * Cached by the target commit and the commit list; a result with a lot of conflicted text is not stored.
   */
  cherryPick(
    onto: ResolvedSnapshot,
    commits: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitCherryPick> {
    return this.#cache.remember(
      onto.cacheScope,
      `cherry-pick|${onto.commit}|${commits.join(',')}`,
      GitCherryPickSchema,
      () =>
        cherryPickSeries(
          { git: this.#git, snapshots: this.#snapshots, scratchDir: this.#scratchDir },
          onto,
          commits,
          signal,
        ),
      (result) =>
        result.steps.reduce(
          (total, step) =>
            total + step.conflictedFiles.reduce((sum, file) => sum + (file.text?.length ?? 0), 0),
          0,
        ) <= MAX_CACHED_CONFLICT_CHARS,
    );
  }

  /** The git version the server runs (asked once, then remembered). */
  #version(): Promise<string> {
    this.#gitVersion ??= this.#git.version();
    return this.#gitVersion;
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
