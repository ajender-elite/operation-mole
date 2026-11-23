# API reference

All endpoints are under `/api` and use JSON. Errors return `{ "message": string }` with status 400, 404, 409 or 500 (see [architecture](architecture.md#error-handling)). Types are in `packages/shared/src/api.ts`, and request schemas are in `packages/shared/src/schemas.ts`.

**Path parameters:**

- `:user`: a username. It's lowercased and must match `^[a-z0-9][a-z0-9._-]{0,31}$`.
- `:sessionId`: a session id (UUID).

## Sessions

### `GET /api/users/:user/sessions`

Returns `SessionSummary[]`, newest activity first. A user with no sessions gets `[]`.

```ts
interface SessionSummary {
  id: string;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // last activity (created, repo added, comparison run)
  repoCount: number;
}
```

### `POST /api/users/:user/sessions`

Body: `{ "name": string }` (trimmed, 1–60 characters). Returns **201** with a `SessionSummary`, or **409** if the user already has a session with that name (case-insensitive). The user is created on first use.

### `GET /api/users/:user/sessions/:sessionId`

Returns a `SessionDetail`, or **404** if the session doesn't exist or belongs to someone else.

```ts
interface SessionDetail {
  user: string;
  session: SessionSummary;
  repos: RepoInfo[];
  recent: RecentComparison[]; // newest first, at most 20
}
```

### `DELETE /api/users/:user/sessions/:sessionId`

Deletes the session, its repos and recent comparisons, and its folder on disk. Returns **204**, or **404**.

## Repositories

### `POST /api/users/:user/sessions/:sessionId/repos`

Body: `{ "url": string }`. Clones the repo into the session, or returns the existing clone if the session already has that URL (ignoring a trailing slash).

| Result                    | Status |
| ------------------------- | ------ |
| Newly cloned              | 201    |
| Already in the session    | 200    |
| Invalid URL, clone failed | 400    |
| Session not found         | 404    |

```ts
interface RepoInfo {
  id: string;
  url: string;
  name: string; // last path segment without .git
  defaultBranch: string;
  branches: string[]; // sorted like file names
  fetchedAt: string; // cloned or last fetched
}
```

### `POST /api/users/:user/sessions/:sessionId/repos/:repoId/fetch`

Fetches every branch from the remote: new commits and new branches are added, and branches deleted on the remote are removed. The default branch is updated too. Returns the updated `RepoInfo`. Checkouts move to the new commits the next time they're compared.

## Comparing

### `POST /api/compare/directories`

```ts
type Source =
  | { type: 'path'; path: string } // absolute path
  | { type: 'git'; repoId: string; branch: string }; // branch, tag, or (abbreviated) commit SHA

interface Body {
  left: Source | string; // a bare absolute path is shorthand for a path source
  right: Source | string;
  user?: string; // required for git sources; with sessionId, records the comparison
  sessionId?: string;
}
```

Returns a `DirectoryCompareResult`:

```ts
interface DirectoryCompareResult {
  left: string; // absolute root that was compared (a worktree folder for git sources)
  right: string;
  leftLabel: string; // the path, or "repo @ branch"
  rightLabel: string;
  root: CompareNode;
  summary: {
    identical: number;
    modified: number;
    onlyLeft: number;
    onlyRight: number;
    errors: number;
  };
  leftSnapshot?: { commit: string; ref: string }; // git sides: the exact commit compared
  rightSnapshot?: { commit: string; ref: string };
}

interface CompareNode {
  name: string; // '' for the root
  path: string; // POSIX path relative to the roots, '' for the root
  status: 'identical' | 'modified' | 'only-left' | 'only-right' | 'error';
  left?: EntryInfo; // present if the entry exists on that side
  right?: EntryInfo;
  children?: CompareNode[]; // present for folders, already sorted
  error?: string;
  renamedTo?: string; // only-left file git detected as renamed (git sides only)
  renamedFrom?: string; // only-right file git detected as renamed
  similarity?: number; // rename similarity, percent
}

interface EntryInfo {
  kind: 'file' | 'directory' | 'symlink';
  size: number;
  mtimeMs: number;
  linkTarget?: string;
}
```

Errors:

- **400**: invalid body, a missing root or one that isn't a folder, a git source without a session, an unknown branch.
- **404**: unknown session, or a repo that isn't in the session.

What each status means is covered in [comparison rules](comparison-rules.md).

### `GET /api/compare/files?left=<abs>&right=<abs>`

At least one side is required.

```ts
interface FileCompareResult {
  left?: FileContent;
  right?: FileContent;
  identical: boolean; // both present and byte-for-byte equal
}

interface FileContent {
  path: string;
  size: number;
  sha256: string;
  binary: boolean; // NUL byte in the first 8 KB
  content?: string; // text files up to 5 MB
  tooLarge?: boolean; // text file over the limit
}
```

Returns **404** for a missing file, and **400** if a path is a folder.

## Snapshot analysis

These need git sources on both sides and a session (`user`, `sessionId` in the body). Results describe exact commits and are cached by SHA. A client that disconnects cancels the git work.

### `POST /api/snapshot/file-diff`

Body: `{ left: GitSource, right: GitSource, user, sessionId, leftPath?, rightPath?, fullFile? }`. Give both paths for a modified or renamed file, one for a one-sided file. Paths are POSIX, relative, without `.`/`..`, and read literally (no pathspec magic).

```ts
interface SnapshotFileDiff {
  leftCommit: string;
  rightCommit: string;
  leftPath?: string;
  rightPath?: string;
  content: 'text' | 'identical' | 'binary' | 'too-large';
  hunks: DiffHunk[]; // git's hunks, Base → Target (3 lines of context, or the whole file)
  commits: DivergenceCommit[]; // every commit a line points to
  attributionNote?: string; // e.g. git blame failed on one side
  truncated?: boolean; // more than 20,000 lines
}
interface DiffHunk {
  header: string; // "@@ -a,b +c,d @@ …"
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  lines: Array<{
    kind: 'context' | 'removed' | 'added';
    text: string;
    leftLine?: number; // context and removed
    rightLine?: number; // context and added
    commit?: string; // git blame on the line's own side (removed: Base, added: Target)
  }>;
}
interface DivergenceCommit {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authorDate: string; // %aI
  committerName: string;
  committerEmail: string;
  commitDate: string; // %cI
  inLeft: boolean | null; // reachable from the Base snapshot (null: unknown)
  inRight: boolean | null;
}
```

**404** for a path missing from its snapshot; **400** for a bad path or a non-file (e.g. a submodule).

## Upstream applicability

`upstream` is the snapshot whose commits are examined (Base), `downstream` the one they are applied to (Target).

### `POST /api/upstream/commits`

Body: `{ upstream, downstream, user, sessionId, limit = 20 (1–200), since?: 'YYYY-MM-DD', firstParent = false, hideReachable = false }`. `since` is `git log --since` (commit date, from the start of that day in server time). `hideReachable` lists `upstream ^downstream`.

```ts
interface UpstreamCommitList {
  upstream: { commit: string; ref: string };
  downstream: { commit: string; ref: string };
  upstreamLabel: string;
  downstreamLabel: string;
  commits: Array<CommitInfo & { parents: string[]; reachableFromDownstream: boolean }>;
  hasMore: boolean; // more commits match than `limit`
}
```

### `POST /api/upstream/applicability`

Body: `{ upstream, downstream, user, sessionId, commit }` (a full SHA). Applies that commit alone to the downstream commit. See [investigation model](investigation-model.md#applicability-states) for what each status means.

```ts
interface ApplicabilityResult {
  commit: string;
  downstreamCommit: string;
  status: 'clean' | 'represented' | 'conflict' | 'unknown';
  reason:
    'reachable' | 'equivalent-patch' | 'no-effective-change' | 'applies' | 'conflict' | 'error';
  baseParent?: string; // first parent; absent for a root commit
  isMerge: boolean;
  files: Array<{
    path: string;
    oldPath?: string;
    outcome: 'applies' | 'already-present' | 'conflict';
  }>;
  equivalentCommits: CommitInfo[]; // same patch-id, downstream only
  conflicts: Array<{ path: string; startLine: number; lines: string[] }>; // marker excerpts
  messages: string[]; // git's, e.g. "CONFLICT (content): Merge conflict in x"
  detail?: string;
}
```

**404** when the commit isn't in the upstream repository.

### `POST /api/upstream/patch`

Body: `{ upstream, user, sessionId, commit }`. The commit's files and hunks against its first parent (`CommitPatch`: `files[]` with `oldPath`, `newPath`, `status`, `binary`, `hunks`; `truncated`).

## Other

### `GET /api/defaults`

Returns `{ left?: string; right?: string }`: the folders a new comparison opens with. These are `examples/left` and `examples/right` unless `OM_LEFT` or `OM_RIGHT` is set.
