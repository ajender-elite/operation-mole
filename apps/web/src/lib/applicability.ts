import type {
  ApplicabilityFile,
  ApplicabilityResult,
  CommitInfo,
  ConflictExcerpt,
  GitSource,
  PatchFile,
} from '@om/shared';
import { gitAncestry, gitMergeTree, gitPatchEquivalents, gitShow } from './api.ts';
import type { UpstreamPair } from './upstream.ts';

/** How long the patch-equivalence search may run before it is reported as unfinished (never as "none"). */
const EQUIVALENCE_TIMEOUT_MS = 20_000;
/** Conflict lines shown per conflicted file, and the context kept around each conflict region. */
const MAX_EXCERPT_LINES = 120;
const CONFLICT_CONTEXT = 3;
const MERGE_NOTE =
  'Merge commit: evaluated as its change against the first parent (like `git cherry-pick -m 1`).';

/**
 * Applicability of one upstream commit to the pinned downstream snapshot, composed in the browser from git
 * primitives: `show` (the commit and its first parent), `ancestry` (already in downstream?), `merge-tree`
 * (the merge, its conflicts and what it changes against downstream) and `patch-equivalents` (downstream
 * commits with the same change). Each commit is evaluated on its own against the same downstream commit.
 */
export async function loadApplicability(
  pinned: UpstreamPair,
  commit: string,
  signal?: AbortSignal,
): Promise<ApplicabilityResult> {
  const { user, sessionId } = pinned;
  const upstream: GitSource = { ...pinned.upstream, branch: commit };
  const downstream = pinned.downstream;
  const shown = await gitShow({ user, sessionId, source: upstream }, signal);
  const parents = shown.details.parents;
  const base = shown.baseParent;
  const touched = shown.files.map(touchedFile);
  const result: ApplicabilityResult = {
    commit,
    downstreamCommit: downstream.branch,
    status: 'unknown',
    reason: 'error',
    ...(base === undefined ? {} : { baseParent: base }),
    isMerge: parents.length > 1,
    files: [],
    equivalentCommits: [],
    conflicts: [],
    messages: [],
  };
  if (result.isMerge) result.detail = MERGE_NOTE;

  try {
    const { results } = await gitAncestry(
      { user, sessionId, tip: downstream, commits: [commit] },
      signal,
    );
    if (results[0]?.isAncestor === true) {
      result.status = 'represented';
      result.reason = 'reachable';
      result.files = touched.map((file) => fileOutcome(file, 'already-present'));
      return result;
    }
    if (base === undefined) {
      // A root commit has no parent to merge from, and git's merge needs one.
      result.detail = 'Root commit: there is no parent to merge from, so it was not evaluated.';
      return result;
    }

    const merged = await gitMergeTree(
      {
        user,
        sessionId,
        ours: downstream,
        theirs: upstream,
        base: { ...pinned.upstream, branch: base },
      },
      signal,
    );
    const changed = new Set(merged.changedPaths);
    const conflicted = new Set(merged.conflictedPaths);
    result.messages = merged.messages;
    result.files = touched.map((file) =>
      fileOutcome(
        file,
        isAny(conflicted, file) ? 'conflict' : isAny(changed, file) ? 'applies' : 'already-present',
      ),
    );
    if (!merged.isClean) {
      result.status = 'conflict';
      result.reason = 'conflict';
      result.conflicts = merged.conflictedFiles.flatMap((file) =>
        file.text === null
          ? []
          : conflictExcerpts(file.path, file.text, { maxLines: MAX_EXCERPT_LINES }),
      );
    } else if (changed.size === 0) {
      result.status = 'represented';
      result.reason = 'no-effective-change';
    } else {
      result.status = 'clean';
      result.reason = 'applies';
    }

    if (result.status === 'represented' || result.status === 'conflict') {
      await findEquivalents(pinned, commit, base, result, signal);
    }
    return result;
  } catch (err) {
    if (signal?.aborted === true) throw err;
    return { ...result, status: 'unknown', reason: 'error', detail: errorMessage(err) };
  }
}

/** Downstream commits that make the same change (`--cherry-mark`), within a time limit. */
async function findEquivalents(
  pinned: UpstreamPair,
  commit: string,
  base: string,
  result: ApplicabilityResult,
  signal?: AbortSignal,
): Promise<void> {
  // Merges have no single patch to compare.
  if (result.isMerge) return;
  const timeout = AbortSignal.timeout(EQUIVALENCE_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const found = await gitPatchEquivalents(
      {
        user: pinned.user,
        sessionId: pinned.sessionId,
        left: pinned.downstream,
        right: { ...pinned.upstream, branch: commit },
        exclude: { ...pinned.upstream, branch: base },
      },
      combined,
    );
    const equivalents: CommitInfo[] = found.commits
      .filter((c) => c.mark === 'equivalent' && c.commit.sha !== commit)
      .map((c) => infoOf(c.commit));
    result.equivalentCommits = equivalents;
    if (equivalents.length > 0 && result.status === 'represented') {
      result.reason = 'equivalent-patch';
    }
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

/** A file the commit touches: its path after the commit, and before it when it was renamed. */
type TouchedFile = { path: string; oldPath: string | undefined };

function touchedFile(file: PatchFile): TouchedFile {
  const path = file.newPath ?? file.oldPath ?? '';
  return {
    path,
    oldPath: file.oldPath !== undefined && file.oldPath !== path ? file.oldPath : undefined,
  };
}

function isAny(paths: ReadonlySet<string>, file: TouchedFile): boolean {
  return paths.has(file.path) || (file.oldPath !== undefined && paths.has(file.oldPath));
}

function fileOutcome(file: TouchedFile, outcome: ApplicabilityFile['outcome']): ApplicabilityFile {
  return {
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    outcome,
  };
}

function infoOf(commit: CommitInfo & { parents: string[] }): CommitInfo {
  return {
    sha: commit.sha,
    subject: commit.subject,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authorDate: commit.authorDate,
    committerName: commit.committerName,
    committerEmail: commit.committerEmail,
    commitDate: commit.commitDate,
  };
}

function appendDetail(detail: string | undefined, text: string): string {
  return detail === undefined ? text : `${detail} ${text}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Conflict-marker regions of a merged file, each with a little context around it (the same rules as the
 * server's excerpts): what a reader needs to see which lines disagree.
 */
export function conflictExcerpts(
  filePath: string,
  text: string,
  { maxLines = MAX_EXCERPT_LINES }: { maxLines?: number } = {},
): ConflictExcerpt[] {
  const lines = text.split('\n');
  const regions: Array<[number, number]> = [];
  let start = -1;
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('<<<<<<<')) start = i;
    else if (line.startsWith('>>>>>>>') && start >= 0) {
      const from = Math.max(0, start - CONFLICT_CONTEXT);
      const to = Math.min(lines.length - 1, i + CONFLICT_CONTEXT);
      const last = regions.at(-1);
      if (last !== undefined && from <= last[1] + 1) last[1] = to;
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
