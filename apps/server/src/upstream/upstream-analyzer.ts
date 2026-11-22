import type {
  ApplicabilityFile,
  ApplicabilityResult,
  CommitInfo,
  CommitPatch,
  ConflictExcerpt,
  PatchFile,
  UpstreamCommit,
} from '@om/shared';
import { createLimiter } from '../compare/limit.ts';
import { NotFoundError, errorMessage } from '../errors.ts';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import {
  COMMIT_FORMAT,
  parseCommitRecords,
  parseMarkedCommitRecords,
  toCommitInfo,
} from '../snapshot/commit-records.ts';
import { parseHunks, splitFilePatches } from '../snapshot/diff-parse.ts';
import { LruCache } from '../snapshot/lru-cache.ts';
import { objectView, withScratchObjects, type ObjectView } from '../snapshot/object-view.ts';
import type { SnapshotAnalyzer } from '../snapshot/snapshot-analyzer.ts';

/** The tree with no entries, per object format: the "parent" of a root commit. */
const EMPTY_TREE: Record<number, string> = {
  40: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  64: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/** Options for {@link UpstreamAnalyzer}. */
export type UpstreamAnalyzerOptions = {
  /** Where temporary object directories for `merge-tree` are created (and removed). */
  scratchDir: string;
  /** How long the patch-equivalence search may run before OM reports it as inconclusive. */
  equivalenceTimeoutMs?: number;
  /** Conflict excerpt lines per file, and files with excerpts. */
  maxExcerptLines?: number;
  maxExcerptFiles?: number;
  /** Patch size limits for {@link UpstreamAnalyzer.patch}. */
  maxPatchFiles?: number;
  maxPatchLines?: number;
};

/** Options for {@link UpstreamAnalyzer.commits}. */
export type CommitWindow = {
  limit: number;
  /** `YYYY-MM-DD`: commits whose commit date is on or after the start of that day (server time). */
  since?: string | undefined;
  firstParent: boolean;
  hideReachable: boolean;
};

type ChangedFile = { status: string; path: string; oldPath?: string };

/** `git diff --name-status -z` records: `M\0path\0`, `R092\0old\0new\0`. */
function parseNameStatus(output: string): ChangedFile[] {
  const tokens = output.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i] ?? '';
    if (status === '') {
      i++;
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
      i += 3;
    } else {
      files.push({ status, path: tokens[i + 1] ?? '' });
      i += 2;
    }
  }
  return files;
}

/** Conflict-marker regions of a merged file, each with `context` lines around it. */
export function conflictExcerpts(
  filePath: string,
  text: string,
  { context = 3, maxLines = 120 }: { context?: number; maxLines?: number } = {},
): ConflictExcerpt[] {
  const lines = text.split('\n');
  const regions: Array<[number, number]> = [];
  let start = -1;
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('<<<<<<<')) start = i;
    else if (line.startsWith('>>>>>>>') && start >= 0) {
      const from = Math.max(0, start - context);
      const to = Math.min(lines.length - 1, i + context);
      const last = regions.at(-1);
      if (last && from <= last[1] + 1) last[1] = to;
      else regions.push([from, to]);
      start = -1;
    }
  }
  const excerpts: ConflictExcerpt[] = [];
  let budget = maxLines;
  for (const [from, to] of regions) {
    if (budget <= 0) break;
    const slice = lines.slice(from, Math.min(to + 1, from + budget));
    budget -= slice.length;
    excerpts.push({ path: filePath, startLine: from + 1, lines: slice });
  }
  return excerpts;
}

/** `git merge-tree --write-tree -z --name-only` output: result tree, conflicted paths, messages. */
function parseMergeTree(output: string): {
  tree: string;
  conflicted: string[];
  messages: string[];
} {
  const tokens = output.split('\0');
  const tree = tokens[0] ?? '';
  const conflicted: string[] = [];
  let i = 1;
  while (i < tokens.length && tokens[i] !== '') conflicted.push(tokens[i++] ?? '');
  i++; // the empty token ending the conflicted-file list
  const messages: string[] = [];
  while (i < tokens.length) {
    const count = Number(tokens[i]);
    if (!Number.isInteger(count) || tokens[i] === '') break;
    // Every path a CONFLICT message names conflicts, including rename/delete and similar
    // cases where the original path has no conflict stages of its own.
    const type = tokens[i + 1 + count] ?? '';
    if (type.startsWith('CONFLICT')) conflicted.push(...tokens.slice(i + 1, i + 1 + count));
    i += 1 + count + 1; // count, paths, conflict type
    const message = tokens[i++];
    if (message !== undefined) messages.push(message.trimEnd());
  }
  return { tree, conflicted: [...new Set(conflicted)], messages };
}

/**
 * Upstream → downstream analysis: which upstream commits exist, and what applying each one
 * to the pristine downstream snapshot would do. Every evaluation starts from the same
 * downstream commit (never from the result of another), runs `git merge-tree` (no index,
 * no worktree, no refs) and writes its objects to a scratch directory removed afterwards.
 */
export class UpstreamAnalyzer {
  readonly #git: GitService;
  readonly #snapshots: SnapshotAnalyzer;
  readonly #options: Required<UpstreamAnalyzerOptions>;
  readonly #results = new LruCache<ApplicabilityResult>(2000);
  readonly #limit = createLimiter(4);

  constructor(git: GitService, snapshots: SnapshotAnalyzer, options: UpstreamAnalyzerOptions) {
    this.#git = git;
    this.#snapshots = snapshots;
    this.#options = {
      equivalenceTimeoutMs: 20_000,
      maxExcerptLines: 120,
      maxExcerptFiles: 10,
      maxPatchFiles: 300,
      maxPatchLines: 20_000,
      ...options,
    };
  }

  /** Upstream's commits (newest first, `git log` order) and whether downstream contains each. */
  async commits(
    upstream: ResolvedSnapshot,
    downstream: ResolvedSnapshot,
    window: CommitWindow,
    signal?: AbortSignal,
  ): Promise<{ commits: UpstreamCommit[]; hasMore: boolean }> {
    const view = objectView(upstream.repoDir, downstream.repoDir);
    const args = ['log', '-z', `--format=${COMMIT_FORMAT}`, `--max-count=${window.limit + 1}`];
    if (window.since !== undefined) args.push(`--since=${window.since}T00:00:00`);
    if (window.firstParent) args.push('--first-parent');
    args.push(upstream.commit);
    if (window.hideReachable) args.push(`^${downstream.commit}`);
    args.push('--');
    const { stdout } = await this.#git.run(view.cwd, args, {
      env: view.env,
      ...(signal ? { signal } : {}),
    });
    const records = parseCommitRecords(stdout);
    const hasMore = records.length > window.limit;
    const commits = await Promise.all(
      records.slice(0, window.limit).map(async (record): Promise<UpstreamCommit> => {
        const isReachable = window.hideReachable
          ? false
          : await this.#snapshots.isAncestor(view, record.sha, downstream.commit, signal);
        return { ...record, reachableFromDownstream: isReachable === true };
      }),
    );
    return { commits, hasMore };
  }

  /** A commit's patch against its first parent (the empty tree for a root commit). */
  async patch(
    upstream: ResolvedSnapshot,
    commit: string,
    signal?: AbortSignal,
  ): Promise<CommitPatch> {
    const opt = signal ? { signal } : {};
    const { parents, base } = await this.#parents(upstream.repoDir, commit, opt);
    const diffTree = (...flags: string[]) =>
      this.#git.run(
        upstream.repoDir,
        ['diff-tree', '-r', '-M', '--no-commit-id', ...flags, base, commit, '--'],
        opt,
      );
    // Same diff, same order: the name-status list says unambiguously which file each patch is.
    const [nameStatus, patch] = await Promise.all([
      diffTree('-z', '--name-status'),
      diffTree('-p', '--no-color', '--no-ext-diff', '--no-textconv'),
    ]);
    const changed = parseNameStatus(nameStatus.stdout);
    const chunks = splitFilePatches(patch.stdout);
    let budget = this.#options.maxPatchLines;
    let isTruncated = changed.length > this.#options.maxPatchFiles;
    const files = changed.slice(0, this.#options.maxPatchFiles).map((file, i): PatchFile => {
      const chunk = chunks[i] ?? '';
      const parsed = parseHunks(chunk, Math.max(budget, 0));
      budget -= parsed.hunks.reduce((n, h) => n + h.lines.length, 0);
      if (parsed.isTruncated) isTruncated = true;
      const status = file.status[0];
      return {
        ...(status === 'A' ? {} : { oldPath: file.oldPath ?? file.path }),
        ...(status === 'D' ? {} : { newPath: file.path }),
        status:
          status === 'A'
            ? 'added'
            : status === 'D'
              ? 'deleted'
              : status === 'M'
                ? 'modified'
                : status === 'R'
                  ? 'renamed'
                  : 'other',
        binary: /^Binary files .* differ$/m.test(chunk),
        hunks: parsed.hunks,
      };
    });
    return {
      commit,
      ...(parents[0] === undefined ? {} : { baseParent: parents[0] }),
      files,
      truncated: isTruncated,
    };
  }

  /**
   * Applicability(commit, downstream): applies the commit's change (against its first parent)
   * to the pristine downstream snapshot with `git merge-tree` and classifies the outcome.
   * Never claims more than git shows: a conflict says nothing about whether the change is
   * "missing", and a clean apply says nothing about semantic safety.
   */
  async applicability(
    upstream: ResolvedSnapshot,
    downstream: ResolvedSnapshot,
    commit: string,
    signal?: AbortSignal,
  ): Promise<ApplicabilityResult> {
    const key = `${commit}>${downstream.commit}`;
    const cached = this.#results.get(key);
    if (cached) return cached;
    const result = await this.#limit(() => this.#evaluate(upstream, downstream, commit, signal));
    if (result.reason !== 'error') this.#results.set(key, result);
    return result;
  }

  async #evaluate(
    upstream: ResolvedSnapshot,
    downstream: ResolvedSnapshot,
    commit: string,
    signal?: AbortSignal,
  ): Promise<ApplicabilityResult> {
    const opt = signal ? { signal } : {};
    const view = objectView(upstream.repoDir, downstream.repoDir);
    const { parents, base } = await this.#parents(upstream.repoDir, commit, opt);
    const result: ApplicabilityResult = {
      commit,
      downstreamCommit: downstream.commit,
      status: 'unknown',
      reason: 'error',
      ...(parents[0] === undefined ? {} : { baseParent: parents[0] }),
      isMerge: parents.length > 1,
      files: [],
      equivalentCommits: [],
      conflicts: [],
      messages: [],
    };
    if (result.isMerge) {
      result.detail =
        'Merge commit: evaluated as its change against the first parent (like `git cherry-pick -m 1`).';
    }

    try {
      // What the commit changes. In a blob-less clone this also downloads those blobs.
      const touched = parseNameStatus(
        (
          await this.#git.run(
            upstream.repoDir,
            ['diff-tree', '-r', '-M', '-z', '--name-status', '--no-commit-id', base, commit, '--'],
            opt,
          )
        ).stdout,
      );

      // Both versions of every touched file, in one request (blob-less clones), so merge-tree
      // finds them locally instead of fetching them into its throwaway object directory.
      await this.#git.prefetchMissing(
        upstream.repoDir,
        parents[0] === undefined ? [commit] : [parents[0], commit],
        touched.flatMap((f) => (f.oldPath === undefined ? [f.path] : [f.oldPath, f.path])),
        { isWalking: false, ...opt },
      );

      if ((await this.#snapshots.isAncestor(view, commit, downstream.commit, signal)) === true) {
        result.status = 'represented';
        result.reason = 'reachable';
        result.files = touched.map((f) => fileOutcome(f, 'already-present'));
        return result;
      }

      await withScratchObjects(view, this.#options.scratchDir, async (scratch) => {
        const merge = await this.#git.run(
          scratch.cwd,
          [
            'merge-tree',
            '--write-tree',
            '-z',
            '--name-only',
            `--merge-base=${base}`,
            downstream.commit,
            commit,
          ],
          { env: scratch.env, okExitCodes: [0, 1], ...opt },
        );
        const { tree, conflicted, messages } = parseMergeTree(merge.stdout);
        result.messages = messages;
        const changedByApply = new Set(
          (
            await this.#git.run(
              scratch.cwd,
              [
                'diff-tree',
                '-r',
                '-z',
                '--name-only',
                '--no-renames',
                downstream.commit,
                tree,
                '--',
              ],
              { env: scratch.env, ...opt },
            )
          ).stdout
            .split('\0')
            .filter(Boolean),
        );
        const conflictedSet = new Set(conflicted);
        result.files = touched.map((f) =>
          fileOutcome(
            f,
            conflictedSet.has(f.path) || (f.oldPath !== undefined && conflictedSet.has(f.oldPath))
              ? 'conflict'
              : changedByApply.has(f.path) ||
                  (f.oldPath !== undefined && changedByApply.has(f.oldPath))
                ? 'applies'
                : 'already-present',
          ),
        );

        if (merge.exitCode === 1) {
          result.status = 'conflict';
          result.reason = 'conflict';
          result.conflicts = await this.#excerpts(scratch, tree, conflicted, opt);
        } else if (changedByApply.size === 0) {
          result.status = 'represented';
          result.reason = 'no-effective-change';
        } else {
          result.status = 'clean';
          result.reason = 'applies';
        }
      });

      if (result.status === 'represented' || result.status === 'conflict') {
        await this.#findEquivalents(view, downstream, commit, parents, result, signal);
      }
      return result;
    } catch (err) {
      if (signal?.aborted === true) throw err;
      if (err instanceof NotFoundError) throw err;
      return { ...result, status: 'unknown', reason: 'error', detail: errorMessage(err) };
    }
  }

  async #parents(
    repoDir: string,
    commit: string,
    opt: { signal?: AbortSignal },
  ): Promise<{ parents: string[]; base: string }> {
    let line: string;
    try {
      line = (
        await this.#git.run(
          repoDir,
          ['rev-list', '--parents', '--max-count=1', `${commit}^{commit}`, '--'],
          opt,
        )
      ).stdout.trim();
    } catch (err) {
      if (opt.signal?.aborted === true) throw err;
      throw new NotFoundError(`Commit ${commit} not found in the upstream repository`);
    }
    const [, ...parents] = line.split(' ');
    const base = parents[0] ?? EMPTY_TREE[commit.length] ?? EMPTY_TREE[40] ?? '';
    return { parents, base };
  }

  async #excerpts(
    scratch: ObjectView,
    tree: string,
    conflicted: string[],
    opt: { signal?: AbortSignal },
  ): Promise<ConflictExcerpt[]> {
    const excerpts: ConflictExcerpt[] = [];
    for (const filePath of conflicted.slice(0, this.#options.maxExcerptFiles)) {
      try {
        const { stdout } = await this.#git.runBuffer(
          scratch.cwd,
          ['cat-file', 'blob', `${tree}:${filePath}`],
          {
            env: scratch.env,
            maxBytes: 8 * 1024 * 1024,
            ...opt,
          },
        );
        if (stdout.subarray(0, 8000).includes(0)) continue; // binary: no markers to show
        excerpts.push(
          ...conflictExcerpts(filePath, stdout.toString('utf8'), {
            maxLines: this.#options.maxExcerptLines,
          }),
        );
      } catch (err) {
        if (opt.signal?.aborted === true) throw err;
        // e.g. modify/delete: the path may be absent from the result tree; messages explain it.
      }
    }
    return excerpts;
  }

  /**
   * Downstream commits with the same patch-id as `commit` (`git log --cherry-mark` over
   * downstream-only commits vs this one commit). Bounded by a timeout; a timeout is reported
   * as inconclusive evidence, never as "no equivalent".
   */
  async #findEquivalents(
    view: ObjectView,
    downstream: ResolvedSnapshot,
    commit: string,
    parents: string[],
    result: ApplicabilityResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (result.isMerge) return; // merges have no patch-id
    const timeout = AbortSignal.timeout(this.#options.equivalenceTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const args = [
      'log',
      '-z',
      '--left-right',
      '--cherry-mark',
      '--no-merges',
      `--format=%m%x1f${COMMIT_FORMAT}`,
      `${downstream.commit}...${commit}`,
    ];
    if (parents[0] !== undefined) args.push(`^${parents[0]}`);
    args.push('--');
    try {
      const { stdout } = await this.#git.run(view.cwd, args, { env: view.env, signal: combined });
      const equivalents: CommitInfo[] = parseMarkedCommitRecords(stdout)
        .filter(({ mark, commit: c }) => mark === '=' && c.sha !== commit)
        .map(({ commit: c }) => toCommitInfo(c));
      result.equivalentCommits = equivalents;
      if (equivalents.length > 0 && result.status === 'represented')
        result.reason = 'equivalent-patch';
      if (equivalents.length > 0 && result.status === 'conflict') {
        result.detail = appendDetail(
          result.detail,
          'Downstream has a commit with the same patch-id, so this change was very likely integrated already; later downstream changes to the same lines make it conflict now.',
        );
      }
    } catch (err) {
      if (signal?.aborted === true) throw err;
      result.detail = appendDetail(
        result.detail,
        `The patch-equivalence search did not finish (${timeout.aborted ? 'timed out' : errorMessage(err)}); equivalent downstream commits may exist.`,
      );
    }
  }
}

function appendDetail(detail: string | undefined, text: string): string {
  return detail === undefined ? text : `${detail} ${text}`;
}

function fileOutcome(file: ChangedFile, outcome: ApplicabilityFile['outcome']): ApplicabilityFile {
  return {
    path: file.path,
    ...(file.oldPath !== undefined && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
    outcome,
  };
}
