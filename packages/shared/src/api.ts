import type { Source } from './schemas.ts';

/** Kind of filesystem entry, as seen without following symlinks. */
export type EntryKind = 'file' | 'directory' | 'symlink';

/**
 * Result of comparing one relative path across the two directories.
 * - `identical`: present in both and byte-for-byte equal (for directories: every descendant identical)
 * - `modified`: present in both but different (for directories: contains differences)
 * - `only-left` / `only-right`: present in one directory only
 * - `error`: could not be read
 */
export type CompareStatus = 'identical' | 'modified' | 'only-left' | 'only-right' | 'error';

/** One side of a compared entry, as seen by `lstat` (symlinks are not followed). */
export type EntryInfo = {
  kind: EntryKind;
  /** Size in bytes (0 for directories). */
  size: number;
  mtimeMs: number;
  /** Link target, for symlinks only. */
  linkTarget?: string;
};

/** One entry of a folder comparison; folders carry their children. */
export type CompareNode = {
  /** Entry name ('' for the root). */
  name: string;
  /** Path relative to the compared roots, POSIX separators ('' for the root). */
  path: string;
  status: CompareStatus;
  left?: EntryInfo;
  right?: EntryInfo;
  /** Present when the entry is a directory on at least one side. Sorted: directories first, then by name. */
  children?: CompareNode[];
  error?: string;
  /** Only-in-Base file that git detected as renamed to this Target path (git sides only). */
  renamedTo?: string;
  /** Only-in-Target file that git detected as renamed from this Base path (git sides only). */
  renamedFrom?: string;
  /** Rename similarity in percent (100 = same content). Present with `renamedTo`/`renamedFrom`. */
  similarity?: number;
};

/** Counts of non-directory entries (files and symlinks) by status. */
export type CompareSummary = {
  identical: number;
  modified: number;
  onlyLeft: number;
  onlyRight: number;
  errors: number;
};

/** Response of `POST /api/compare/directories`. */
export type DirectoryCompareResult = {
  /** Absolute root folders that were compared (a checkout folder for git sources). */
  left: string;
  right: string;
  /** Human-readable names for each side, e.g. a path or "repo @ branch". */
  leftLabel: string;
  rightLabel: string;
  root: CompareNode;
  summary: CompareSummary;
  /** The exact commit a git Base side resolved to. */
  leftSnapshot?: SnapshotInfo;
  /** The exact commit a git Target side resolved to. */
  rightSnapshot?: SnapshotInfo;
};

/** One side of a file diff. Binary or too-large files carry no `content`. */
export type FileContent = {
  path: string;
  size: number;
  sha256: string;
  binary: boolean;
  /** Present for text files under the size limit. */
  content?: string;
  /** True when the file is text but too large to show. */
  tooLarge?: boolean;
};

/** Response of `GET /api/compare/files`. A missing side means only one file was given. */
export type FileCompareResult = {
  left?: FileContent;
  right?: FileContent;
  /** True when both files are present and byte-for-byte equal. */
  identical: boolean;
};

/** Body of every 4xx/5xx API response. */
export type ApiError = {
  message: string;
};

/** A session as listed on the Sessions page. Timestamps are ISO-8601. */
export type SessionSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  repoCount: number;
};

/** A repo cloned into a session. */
export type RepoInfo = {
  id: string;
  url: string;
  /** Short display name, e.g. "delta" for https://github.com/acme/delta.git. */
  name: string;
  defaultBranch: string;
  branches: string[];
  /** When the repo was cloned or last fetched. */
  fetchedAt: string;
};

/** A comparison remembered in a session, newest first. Repeating one moves it to the top. */
export type RecentComparison = {
  id: string;
  left: Source;
  right: Source;
  leftLabel: string;
  rightLabel: string;
  comparedAt: string;
};

/** Response of `GET /api/users/:user/sessions/:sessionId`. */
export type SessionDetail = {
  user: string;
  session: SessionSummary;
  repos: RepoInfo[];
  recent: RecentComparison[];
};

/**
 * A git side resolved to an exact commit. This is the snapshot's real identity: a branch
 * name can move after **Fetch latest**, the commit cannot.
 */
export type SnapshotInfo = {
  /** Full commit SHA the side resolved to. */
  commit: string;
  /** What was asked for: a branch, a tag or a commit SHA. */
  ref: string;
};

/** Which snapshot a line, hunk or commit belongs to: `left` is Base, `right` is Target. */
export type SnapshotSide = 'left' | 'right';

/** Commit metadata exactly as git records it. Dates are ISO-8601. */
export type CommitInfo = {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** When the change was originally written (`%aI`). */
  authorDate: string;
  committerName: string;
  committerEmail: string;
  /** When this commit object was created (`%cI`); rebases and cherry-picks reset it. */
  commitDate: string;
};

/** A commit's git metadata plus its parents, in order (first parent first). */
export type CommitDetails = CommitInfo & { parents: string[] };

/**
 * A commit that currently accounts for at least one differing line (`git blame` on that
 * line's own side). It is NOT necessarily the commit that first introduced the content or
 * that historically caused the divergence.
 */
export type DivergenceCommit = CommitInfo & {
  /** Reachable from the Base snapshot; null when git could not tell. */
  inLeft: boolean | null;
  /** Reachable from the Target snapshot; null when git could not tell. */
  inRight: boolean | null;
};

/**
 * One line of a hunk. `removed` lines exist only on the Base side of this hunk, `added`
 * lines only on the Target side (the diff reads Base → Target).
 */
export type DiffLine = {
  kind: 'context' | 'removed' | 'added';
  text: string;
  /** 1-based line number in the Base file (context and removed lines). */
  leftLine?: number;
  /** 1-based line number in the Target file (context and added lines). */
  rightLine?: number;
  /**
   * Commit that `git blame` currently attributes this line to, in the history of the line's
   * own side (removed → Base history, added → Target history). Absent for context lines and
   * when attribution was unavailable.
   */
  commit?: string;
};

/** A hunk of a unified diff, as git computed it. */
export type DiffHunk = {
  /** The `@@ -a,b +c,d @@ …` line. */
  header: string;
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  lines: DiffLine[];
};

/** How a file's two versions could be compared. */
export type DiffContentKind = 'text' | 'identical' | 'binary' | 'too-large';

/** Response of `POST /api/snapshot/file-diff`: one file between two git snapshots, with attribution. */
export type SnapshotFileDiff = {
  leftCommit: string;
  rightCommit: string;
  /** Path in the Base snapshot (absent when the file only exists in the Target). */
  leftPath?: string;
  /** Path in the Target snapshot (absent when the file only exists in the Base). */
  rightPath?: string;
  content: DiffContentKind;
  hunks: DiffHunk[];
  /** Every commit referenced by a line's `commit`, with reachability from each side. */
  commits: DivergenceCommit[];
  /** Why some changed lines carry no commit (e.g. git blame failed). */
  attributionNote?: string;
  /** True when the diff was cut to keep the response small. */
  truncated?: boolean;
};

/** A commit in an upstream window, with its relationship to the downstream snapshot. */
export type UpstreamCommit = CommitInfo & {
  parents: string[];
  /** Exactly this commit is in downstream's history (`git merge-base --is-ancestor`). */
  reachableFromDownstream: boolean;
};

/** Response of `POST /api/upstream/commits`. */
export type UpstreamCommitList = {
  upstream: SnapshotInfo;
  downstream: SnapshotInfo;
  upstreamLabel: string;
  downstreamLabel: string;
  commits: UpstreamCommit[];
  /** More commits match the window than `limit` allowed. */
  hasMore: boolean;
};

/**
 * Outcome of applying one upstream commit to the pristine downstream snapshot:
 * - `clean`: applies without conflicts and changes downstream's content
 * - `represented`: applying it changes nothing (or the commit is already reachable)
 * - `conflict`: git cannot apply it automatically
 * - `unknown`: OM could not decide (see `detail`)
 */
export type ApplicabilityStatus = 'clean' | 'represented' | 'conflict' | 'unknown';

/**
 * Why OM reached the status:
 * - `reachable`: the exact commit is in downstream's history
 * - `equivalent-patch`: applying changes nothing, and downstream has a commit with the same patch-id
 * - `no-effective-change`: applying changes nothing, with no patch-equivalent commit found
 * - `applies`: applies cleanly and changes content
 * - `conflict`: git reported conflicts
 * - `error`: git failed; see `detail`
 */
export type ApplicabilityReason =
  'reachable' | 'equivalent-patch' | 'no-effective-change' | 'applies' | 'conflict' | 'error';

/** What applying the commit does to one file it touches. */
export type ApplicabilityFile = {
  path: string;
  /** Previous path when the commit renames the file. */
  oldPath?: string;
  /**
   * - `applies`: downstream's file changes
   * - `already-present`: downstream's file already matches the result
   * - `conflict`: git could not merge this file
   */
  outcome: 'applies' | 'already-present' | 'conflict';
};

/** Conflict markers git left in one file of the merge result, with a little context. */
export type ConflictExcerpt = {
  path: string;
  /** 1-based line of the excerpt's first line in the conflicted result. */
  startLine: number;
  lines: string[];
};

/** Response of `POST /api/upstream/applicability`. */
export type ApplicabilityResult = {
  commit: string;
  /** The pristine downstream commit the upstream commit was applied to. */
  downstreamCommit: string;
  status: ApplicabilityStatus;
  reason: ApplicabilityReason;
  /** Parent the patch was taken against: the first parent for merges; absent for a root commit. */
  baseParent?: string;
  isMerge: boolean;
  files: ApplicabilityFile[];
  /** Downstream commits whose patch-id equals this commit's (`git log --cherry-mark`). */
  equivalentCommits: CommitInfo[];
  conflicts: ConflictExcerpt[];
  /** Git's own messages (e.g. `CONFLICT (content): Merge conflict in x`). */
  messages: string[];
  /** Explanation for `unknown`, or a caveat about the evidence. */
  detail?: string;
};

/** One file of a commit's patch. */
export type PatchFile = {
  /** Path before the commit (absent for an added file). */
  oldPath?: string;
  /** Path after the commit (absent for a deleted file). */
  newPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'other';
  binary: boolean;
  hunks: DiffHunk[];
};

/** Response of `POST /api/upstream/patch`: a commit's changes against its first parent. */
export type CommitPatch = {
  commit: string;
  /** The commit's own git metadata, as `git log` reports it. */
  details: CommitDetails;
  baseParent?: string;
  files: PatchFile[];
  /** True when files or lines were left out to keep the response small. */
  truncated: boolean;
};
