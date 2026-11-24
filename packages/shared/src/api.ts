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
  /** Only-in-Left file that git detected as renamed to this Right path (git sides only). */
  renamedTo?: string;
  /** Only-in-Right file that git detected as renamed from this Left path (git sides only). */
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

/** Whether a remote answers now. `message` is git's reason when it does not, with credentials removed. */
export type RemoteCheck = {
  reachable: boolean;
  message: string;
};

/** One remote of a repo: another place the same repository lives, with its own branches. */
export type RemoteInfo = {
  name: string;
  url: string;
  defaultBranch: string;
  branches: string[];
  /** When this remote was added or last fetched. */
  fetchedAt: string;
};

/** A repo cloned into a session. The top-level fields describe its first remote (`origin`). */
export type RepoInfo = {
  remotes: RemoteInfo[];
  id: string;
  url: string;
  /** Short display name, e.g. "delta" for https://github.com/acme/delta.git. */
  name: string;
  defaultBranch: string;
  branches: string[];
  /** When the repo was cloned or last fetched. */
  fetchedAt: string;
};

/** How many sessions, repos and remotes there may be (the server's `OM_MAX_*` settings). */
export type ServerLimits = {
  sessionsPerUser: number;
  reposPerSession: number;
  remotesPerRepo: number;
};

/**
 * What the server's git can do and how it reaches remotes (`GET /api/server`). Names and flags only:
 * never a URL, a credential or an environment value.
 */
export type ServerInfo = {
  git: { version: string };
  access: {
    /** The URL schemes git may use (`GIT_ALLOW_PROTOCOL`). */
    protocols: string[];
    /** Always false: git never prompts (`GIT_TERMINAL_PROMPT=0`, SSH `BatchMode`). */
    isInteractive: boolean;
    /** Whether an SSH agent is available to the server (`SSH_AUTH_SOCK` is set). */
    hasSshAgent: boolean;
  };
  limits: ServerLimits;
};

/** Response of `GET /api/users/:user/sessions/:sessionId`. */
export type SessionDetail = {
  user: string;
  session: SessionSummary;
  repos: RepoInfo[];
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

/** Which snapshot a line, hunk or commit belongs to: `left` is Left, `right` is Right. */
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
  /** Reachable from the Left snapshot; null when git could not tell. */
  inLeft: boolean | null;
  /** Reachable from the Right snapshot; null when git could not tell. */
  inRight: boolean | null;
};

/**
 * One line of a hunk. `removed` lines exist only on the Left side of this hunk, `added`
 * lines only on the Right side (the diff reads Left → Right).
 */
export type DiffLine = {
  kind: 'context' | 'removed' | 'added';
  text: string;
  /** 1-based line number in the Left file (context and removed lines). */
  leftLine?: number;
  /** 1-based line number in the Right file (context and added lines). */
  rightLine?: number;
  /**
   * Commit that `git blame` currently attributes this line to, in the history of the line's
   * own side (removed → Left history, added → Right history). Absent for context lines and
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

/** One file's hunks between two git sides, as `POST /api/git/diff` returns it (attribution is added by the browser). */
export type SnapshotFileDiff = {
  leftCommit: string;
  rightCommit: string;
  /** Path in the Left snapshot (absent when the file only exists in the Right). */
  leftPath?: string;
  /** Path in the Right snapshot (absent when the file only exists in the Left). */
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
/** A revision a primitive resolved: the commit it names, the ref asked for, and a display label. */
export type GitRevision = { commit: string; ref: string; label: string };

/** One file a commit changed, with its line counts (`git log --numstat`). */
export type GitLogFile = {
  path: string;
  /** Set for a renamed file: where it was before. */
  oldPath?: string | undefined;
  additions: number;
  deletions: number;
  /** Binary files have no lines to count. */
  binary: boolean;
};

/** A commit in a log: metadata and parents, with the body and files when asked for. */
export type GitLogCommit = CommitInfo & {
  parents: string[];
  body?: string | undefined;
  files?: GitLogFile[] | undefined;
};

/**
 * Response of `POST /api/git/log`: the commits reachable from `include` and not from `exclude`
 * (newest first), one page at a time. `total` counts them all; `hasMore` says whether a next page exists.
 */
export type GitLog = {
  include: GitRevision;
  exclude?: GitRevision | undefined;
  commits: GitLogCommit[];
  hasMore: boolean;
  total: number;
  /** With an exclude: whether it is in the history of include. */
  excludeIsAncestor?: boolean | undefined;
};

/** Response of `POST /api/git/resolve`. */
export type GitResolve = { revisions: GitRevision[] };

/** Response of `POST /api/git/merge-base`: the common ancestor, or null when the histories share none. */
export type GitMergeBase = { commit: string | null };

/** One entry of a folder listing: a file, folder, symlink or submodule of one commit. */
export type GitTreeNode = {
  name: string;
  /** The entry's full path in the commit (POSIX). */
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'submodule';
  oid: string;
};

/** Response of `POST /api/git/tree`: one folder of a commit, folders first, then files. */
export type GitTree = {
  commit: string;
  /** The folder listed (`''` for the root). */
  path: string;
  entries: GitTreeNode[];
};

/** Response of `POST /api/git/ancestry`: for each commit, whether it is in the history of the tip (null: git could not tell). */
export type GitAncestry = { results: Array<{ commit: string; isAncestor: boolean | null }> };

/** One line of a file, and the commit that last changed it. */
export type GitBlameLine = {
  /** Line number in the blamed file (1-based). */
  line: number;
  commit: string;
  /** Where the line was in that commit's version of the file. */
  origLine: number;
  /** That commit's path for the file, when it was renamed. */
  origPath?: string | undefined;
  /** The commit is the root of the history (its parent is outside the blame). */
  boundary: boolean;
};

/** Response of `POST /api/git/blame`. */
export type GitBlame = {
  path: string;
  commit: string;
  lines: GitBlameLine[];
  commits: CommitInfo[];
};

/** Response of `POST /api/git/diff`: one diff per requested file pair, with hunks and no attribution. */
export type GitDiff = { files: SnapshotFileDiff[] };

/** Response of `POST /api/git/merge-tree`. */
export type GitMergeTree = {
  ours: GitRevision;
  theirs: GitRevision;
  base: string | null;
  isClean: boolean;
  /** Paths that conflict (empty when the merge is clean). */
  conflictedPaths: string[];
  /** The merged text (with conflict markers) of the first conflicted files; null when binary. */
  conflictedFiles: Array<{ path: string; text: string | null }>;
  /** Paths whose content the merge changes relative to ours (what applying changes here). */
  changedPaths: string[];
  /** Git's messages about the merge (for example "Auto-merging" or a conflict note). */
  messages: string[];
};

/** A commit of a patch-equivalence comparison: the side it is on, or that it has an equal change on the other side. */
export type GitPatchEquivalent = {
  commit: CommitInfo & { parents: string[]; body?: string | undefined };
  mark: 'left' | 'right' | 'equivalent';
};

/** Response of `POST /api/git/patch-equivalents`. */
export type GitPatchEquivalents = {
  left: GitRevision;
  right: GitRevision;
  exclude?: GitRevision | undefined;
  commits: GitPatchEquivalent[];
  /** Some side had more commits than `limit` allows; the newest are kept. */
  truncated?: boolean | undefined;
};

/** A file as one side of a tree comparison sees it. */
export type GitTreeLeaf = {
  kind: 'file' | 'symlink' | 'submodule';
  /** Object id of the blob, or of the submodule commit. */
  oid: string;
  size: number;
};

/** One file path in a tree comparison: its status and what each side has. */
export type GitTreeEntry = {
  path: string;
  status: 'identical' | 'modified' | 'only-left' | 'only-right';
  left?: GitTreeLeaf | undefined;
  right?: GitTreeLeaf | undefined;
};

/**
 * The folder tree of two git sides, as Folder Compare shows it. Git sides have no absolute folders, so
 * it carries labels and the exact commits instead.
 */
export type FolderComparison = {
  leftLabel: string;
  rightLabel: string;
  root: CompareNode;
  summary: CompareSummary;
  leftSnapshot?: SnapshotInfo | undefined;
  rightSnapshot?: SnapshotInfo | undefined;
};

/** Response of `POST /api/git/compare-trees`. Folders are not listed in `entries`: they follow from their files, and `folder` is the tree. */
export type GitCompareTrees = {
  left: GitRevision;
  right: GitRevision;
  entries: GitTreeEntry[];
  renames: Array<{ from: string; to: string; similarity: number }>;
  folder: FolderComparison;
};

export type CommitPatch = {
  commit: string;
  /** The commit's own git metadata, as `git log` reports it. */
  details: CommitDetails;
  baseParent?: string;
  files: PatchFile[];
  /** True when files or lines were left out to keep the response small. */
  truncated: boolean;
};

/** Response of `POST /api/git/files`: every file path of one commit, sorted (a folder is not listed). */
export type GitFiles = {
  commit: string;
  paths: string[];
  /** The commit has more files than the listing keeps. */
  truncated: boolean;
};

/**
 * One file of a commit, as text, binary, or too large to show. `text` is set only for `text`, and
 * `oid` is the blob (equal blobs are equal content).
 */
export type GitFile = {
  commit: string;
  path: string;
  oid: string;
  size: number;
  content: 'text' | 'binary' | 'too-large';
  text?: string | undefined;
};

/** One line that matched a search, with its neighbours when context was asked for. */
export type GitGrepMatch = {
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first match on the line (bytes, as git counts them). */
  column: number;
  text: string;
  /** Up to `context` lines before the match, oldest first, each with its line number. */
  before: Array<{ line: number; text: string }>;
  /** Up to `context` lines after the match, oldest first, each with its line number. */
  after: Array<{ line: number; text: string }>;
};

/** Response of `POST /api/git/grep`. */
export type GitGrep = {
  commit: string;
  matches: GitGrepMatch[];
  /** More matches exist than the response keeps (see the server's limit). */
  truncated: boolean;
};

/** Whether a ref is a branch or a tag of a remote. */
export type GitRefKind = 'branch' | 'tag';

/** One branch or tag of one remote, with the commit it points to. */
export type GitRefEntry = {
  remote: string;
  kind: GitRefKind;
  /** The name without the remote (e.g. `stable-1.28`). */
  name: string;
  commit: string;
  /** Committer date of the tip commit (ISO-8601). */
  commitDate: string;
  subject: string;
  /** Commits this ref has that `compareTo` does not. Present only with `compareTo`, and not on old git. */
  ahead?: number | undefined;
  /** Commits `compareTo` has that this ref does not. */
  behind?: number | undefined;
};

/** Response of `POST /api/git/refs`. */
export type GitRefs = {
  refs: GitRefEntry[];
  compareTo?: GitRevision | undefined;
};

/** Response of `POST /api/git/contains`: every branch or tag whose history includes the commit. */
export type GitContains = {
  commit: string;
  refs: Array<{ remote: string; kind: GitRefKind; name: string }>;
};

/** Response of `POST /api/git/patch-ids`: each commit's patch id (`git patch-id --stable`), or null. */
export type GitPatchIds = {
  results: Array<{ commit: string; patchId: string | null }>;
};

/** Why a commit in a series can't be checked at all (the request is refused before any step runs). */
export type CherryPickIssueProblem = 'not-found' | 'not-a-commit' | 'duplicate' | 'merge' | 'root';

/** One commit of a series that the pre-check refused. */
export type CherryPickIssue = {
  /** Position in the request (0-based). */
  index: number;
  commit: string;
  problem: CherryPickIssueProblem;
  message: string;
};

/** A non-blocking remark about the series (for example, a commit listed before its own parent). */
export type CherryPickWarning = {
  index: number;
  kind: 'parent-after-child';
  message: string;
};

/**
 * What applying one commit did on the result of the commits before it:
 * - `applies`: the commit applied and changed the result
 * - `no-change`: applied, but the result is unchanged (its change is already there)
 * - `in-history`: the commit is already in the target's history, so it was skipped
 * - `conflict`: git could not merge it; the run stopped here
 * - `not-run`: after a conflict, so not applied
 */
export type CherryPickStepStatus = 'applies' | 'no-change' | 'in-history' | 'conflict' | 'not-run';

/** One step of a series check. */
export type CherryPickStep = {
  index: number;
  commit: CommitInfo & { parents: string[] };
  status: CherryPickStepStatus;
  /** Paths the commit changes. */
  files: string[];
  /** Conflicted paths, for `conflict`. */
  conflictedPaths: string[];
  /** The merged text (with markers) of the first conflicted files; null when binary. */
  conflictedFiles: Array<{ path: string; text: string | null }>;
  /** Git's messages about this step. */
  messages: string[];
};

/**
 * Response of `POST /api/git/cherry-pick`:
 * - `applies`: every commit applied, or was skipped as already present
 * - `conflict`: the run stopped at `stoppedAt`; later steps are `not-run`
 * - `invalid`: the request was refused by the pre-check; no step ran (see `issues`)
 */
export type GitCherryPick = {
  onto: GitRevision;
  outcome: 'applies' | 'conflict' | 'invalid';
  /** Index of the step that stopped the run (for `conflict`). */
  stoppedAt?: number | undefined;
  issues: CherryPickIssue[];
  warnings: CherryPickWarning[];
  steps: CherryPickStep[];
  /** Paths the series changes on `onto`, up to the stop. */
  changedPaths: string[];
};
