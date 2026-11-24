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
}
```

### `DELETE /api/users/:user/sessions/:sessionId`

Deletes the session, its repos, and its folder on disk. Returns **204**, or **404**.

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
  url: string; // the first remote's (origin's) URL
  name: string; // last path segment without .git
  defaultBranch: string; // the first remote's
  branches: string[]; // the first remote's, sorted like file names
  fetchedAt: string; // the first remote's: cloned or last fetched
  remotes: RemoteInfo[]; // every remote, origin first
}

interface RemoteInfo {
  name: string; // a slug (^[a-z0-9][a-z0-9_-]{0,39}$), unique within the repo
  url: string; // unique within the repo
  defaultBranch: string;
  branches: string[];
  fetchedAt: string;
}
```

A repo has one or more remotes. The first one, `origin`, is the URL the repo was cloned from; removing it leaves the repo listed under its other remotes.

### `POST /api/users/:user/sessions/:sessionId/repos/:repoId/fetch`

Fetches every remote of the repo: new commits and new branches are added, and branches deleted on a remote are removed. Each remote's default branch is updated too. Returns the updated `RepoInfo`. Checkouts move to the new commits the next time they're compared.

### `DELETE /api/users/:user/sessions/:sessionId/repos/:repoId`

Removes a repo from the session: its clone is deleted first, then its row (so a failed disk delete leaves the repo listed, to retry). Answers 204, or 404 when the repo is not in the session. The repos in a session are limited (see below); deleting one frees its place.

### `POST /api/users/:user/sessions/:sessionId/repos/:repoId/remotes`

Body: `{ "name": string, "url": string }`. Adds another place the repo lives (a fork, a mirror) under its own name, and fetches it. The new remote's branches are available as `GitSource.remote` on the git primitives.

| Result                                                                                                      | Status |
| ----------------------------------------------------------------------------------------------------------- | ------ |
| Added and fetched; returns the updated `RepoInfo`                                                           | 201    |
| Invalid name or URL                                                                                         | 400    |
| Name already used in the repo, URL already used in the repo, or the `OM_MAX_REMOTES_PER_REPO` limit reached | 409    |
| Session or repo not found                                                                                   | 404    |

### `POST /api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote/fetch`

Fetches one remote, leaving the others as they are. Returns the updated `RepoInfo`. **404** when the repo has no remote with that name.

### `DELETE /api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote`

Removes a remote: its configuration, its branches and its tags (`refs/remotes/<name>/` and `refs/remote-tags/<name>/`), then prunes the objects only it used. Answers 204. **404** for a remote the repo does not have. **409** for the repo's last remote: to drop that, remove the repository.

### `GET /api/server`

What the server's git can do and how it reaches remotes. Response: `{ git: { version }, access: { protocols, isInteractive, hasSshAgent }, limits: { sessionsPerUser, reposPerSession, remotesPerRepo } }`. `version` is what `git --version` prints. `protocols` are the URL schemes git may use. `isInteractive` is always `false`: git never prompts. `hasSshAgent` says whether `SSH_AUTH_SOCK` is set. The response never carries a URL, a credential or an environment value.

### Limits

The server enforces three limits, set by `OM_MAX_SESSIONS_PER_USER`, `OM_MAX_REPOS_PER_SESSION` and `OM_MAX_REMOTES_PER_REPO` (each a whole number, default 10). Creating a session or adding a repo past its limit answers **409** and creates nothing. Adding a repo that the session already has answers 200 with that repo, since it adds nothing. Data already over a limit is never deleted; only new creation is refused. The limit check and the write happen together: sessions in one transaction, repos under a lock per session.

At startup the server removes folders that no row names (a repo or session left behind by a crash or an interrupted delete). A folder that is still held (on Windows) stays until the next start.

## Folder comparison and git primitives

Folder Compare is `POST /api/git/compare-trees`, below. The rest are the git primitives: small, git-like endpoints that the frontend composes into its views (file diffs, attribution, applicability and commit windows are all composed there from these).

Small, git-like endpoints that the frontend composes into its views. They take a `GitSource` (repository, a remote, and a branch, tag or commit), never free-form git arguments, and echo the commits they resolved. `remote` names one of the repo's remotes and defaults to `origin`. Two sides may name different remotes of one repo, which is how a fork and its upstream are compared without two clones. An unknown remote answers **400**.

### `POST /api/git/log`

`git log source ^exclude`: the commits reachable from `source` and not from `exclude`, newest first, one page at a time. Body (besides `user` and `sessionId`): `source`, optional `exclude`, optional `paths` (literal paths), `firstParent`, `since` (`YYYY-MM-DD`), `limit` (1–200, default 50), `skip`, `withBody` (the full message), `withStats` (changed files with additions, deletions, renames and binary marks), `grep` (only commits whose message contains this text, fixed and case-insensitive), `author` (only commits whose author name or email contains it, likewise), `topoOrder` (parents before children), and `follow` (one file through its renames; needs exactly one path, else **400**).

Response: `{ include, exclude?, commits, hasMore, total }`. `total` counts the whole range (with `follow`, the commits that touched the file through its renames); `hasMore` says whether another page exists. The excluded commit itself is not in `commits`; a caller that wants a range to end at it shows it as the last entry.

### `POST /api/git/show`

One commit's metadata, parents and changed files with hunks, against its first parent. Body: `source`. Response: `{ commit, details, baseParent?, files, truncated }`, where `details` is the commit's metadata with its `parents` (first parent first) and `files` has `oldPath`, `newPath`, `status`, `binary` and `hunks`.

### `POST /api/git/resolve`

The commit each revision names. Body: `sources` (1 to 20 git sources). Response: `{ revisions: [{ commit, ref, label }] }`. Unknown revisions answer 400.

### `POST /api/git/merge-base`

The best common ancestor of two revisions. Body: `a`, `b`. Response: `{ commit }`, where `commit` is null when the histories share none.

### `POST /api/git/ancestry`

Whether each commit is in the history of `tip`. Body: `tip` and `commits` (1 to 200 full SHAs, looked up in the tip's repository). Response: `{ results: [{ commit, isAncestor }] }`. `isAncestor` is null when git cannot tell (for example, the commit is not in that repository).

### `POST /api/git/blame`

Who last changed each line of a file at a commit. Body: `source`, `path`, and optional `lines` (only those lines). Response: `{ path, commit, lines, commits }`. Each line has `line`, `commit`, `origLine` (its line in that commit), `origPath` (only when the file was renamed), and `boundary`. `commits` holds each attributed commit's metadata. A path that is not a file at that commit answers 404 (or 400 for a folder).

### `POST /api/git/diff`

The hunks for pairs of file paths, Left → Right, with no attribution. Body: `left`, `right`, `files` (1 to 50 pairs of `leftPath` and/or `rightPath`), and `fullFile`. Response: `{ files }`, one diff per pair in the `SnapshotFileDiff` shape (its `commits` is empty).

### `POST /api/git/merge-tree`

Whether `theirs` merges cleanly into `ours`, computed in a scratch object store that is removed afterwards (no ref, index or worktree is touched). Body: `ours`, `theirs`, and optional `base` (their merge base by default). Response: `{ ours, theirs, base, isClean, conflictedPaths, conflictedFiles, changedPaths, messages }`. `conflictedFiles` holds the merged text, with its conflict markers, of the first 10 conflicted files (`text` is `null` for binary files, and a file that is absent from the result, such as a modify/delete conflict, is left out). `changedPaths` lists the paths whose content the merge changes relative to `ours`, which is what applying `theirs` here would change. Two histories with no common ancestor answer 400.

### `POST /api/git/patch-equivalents`

The commits on each side of `left...right` (after `exclude`, when given), newest first, each marked `left` or `right` by side. A commit that makes the same change as a commit on the other side (`git log --cherry-mark`, the same patch-id) is marked `equivalent`. Merge commits are left out. Body: `left`, `right`, optional `exclude`, `withBody` (include each commit's message, for trailers such as `(cherry picked from …)`), and `limit` (at most this many commits, default 500). Response: `{ left, right, exclude?, commits, truncated? }`, where each of `commits` is `{ commit, mark }`, and `commit` has the shape of a `log` commit (with `body` when asked). `truncated` is true when more commits exist than `limit` allows.

### `POST /api/git/compare-trees`

Every file of two trees with its status, compared by object id (nothing is checked out). Body: `left`, `right`, and optional `paths` (only those paths). Response: `{ left, right, entries, renames, folder }`. `folder` is the tree Folder Compare shows: `{ leftLabel, rightLabel, root, summary, leftSnapshot, rightSnapshot }`, where `root` is a `CompareNode` tree (folders first, then files, each in natural order), `summary` counts the files by status, and each snapshot is the exact commit a side resolved to. Each entry has `path`, `status` (`identical`, `modified`, `only-left` or `only-right`), and each side's `left`/`right` leaf (`kind`: `file`, `symlink` or `submodule`; `oid`; `size`). Folders are not listed; they follow from the files under them. `renames` lists the files git detects as moved, with their similarity in percent.

### `POST /api/git/tree`

One folder of a commit, one level deep (`git ls-tree`): its folders and files, folders first, each group in Folder Compare's order. Body: `source` and optional `path` (the root when absent). Response: `{ commit, path, entries }`, where each entry is `{ name, path, kind, oid }` (`kind`: `directory`, `file`, `symlink` or `submodule`). Reads object ids only. Cached by commit and folder. A file or a missing folder answers **400** or **404**.

### `POST /api/git/files`

Every file path of a commit, sorted (`ls-tree -r`, for go-to-file). Body: `source`. Response: `{ commit, paths, truncated }`. No blob is read. More than 200,000 paths are cut, with `truncated` set. Cached by commit.

### `POST /api/git/file`

One file of a commit, whole. Body: `source` and `path`. Response: `{ commit, path, oid, size, content, text? }`, where `content` is `text` (with `text`), `binary` or `too-large` (over 5 MB, with no text). Cached by blob id. A folder answers **400**; a missing path **404**.

### `POST /api/git/grep`

Lines of a commit that match a query (`git grep -n --column -I`), grouped by the caller. Body: `source`, `query`, optional `regex` (POSIX extended, not PCRE), `ignoreCase`, `paths` (up to 100), and `context` (0 to 3 lines). Response: `{ commit, matches, truncated }`, where each match is `{ path, line, column, text, before, after }`. At most 1,000 matches are returned, with `truncated` set when there are more. Binary files are skipped. Cached by commit and query.

### `POST /api/git/refs`

Every branch and tag of every remote of a repo, sorted by remote, then branches before tags, then name. Body: `repoId` and optional `compareTo` (a `source`). Response: `{ refs, compareTo? }`, where each ref is `{ remote, kind, name, commit, commitDate, subject, ahead?, behind? }`. With `compareTo`, `ahead` and `behind` count commits against that commit, in one git call; that needs git 2.41 or later, and older git gives no counts. Not cached: refs move on every fetch.

### `POST /api/git/contains`

Every branch and tag of any remote whose history includes the commit (`for-each-ref --contains`). Body: `source`. Response: `{ commit, refs: [{ remote, kind, name }] }`. Not cached.

### `POST /api/git/patch-ids`

The patch id of each commit (`git patch-id --stable`): equal ids mean the same change. Body: `source` and `commits` (full SHAs, up to 200). Response: `{ results: [{ commit, patchId }] }`, where `patchId` is null for a merge or an empty commit. A commit the repo does not have answers **404**. Cached by the list of commits.

### `POST /api/git/cherry-pick`

Would `git cherry-pick <commits…>` onto a branch succeed, applied in the order given, each on the result of the one before? A dry run: the picks are merged in a scratch object store, removed afterwards, so no ref, index or worktree is touched. Body: `onto` (a `source`, on any of the repo's remotes) and `commits` (full SHAs, 1 to 100).

The request is checked first. A commit that is missing, is not a commit, is listed twice, is a merge, or is a root commit refuses the whole request: `outcome: 'invalid'`, every problem listed in `issues` by position, and no step runs. A commit listed before its own parent gets a `warnings` entry, which does not block.

Otherwise each commit is merged onto the result so far, with its own parent as the base, as `git cherry-pick` does:

- `in-history`: the commit is already in the branch's history; skipped, and the run goes on.
- `no-change`: the commit applies, but the result is unchanged (its change is already there); the run goes on.
- `applies`: the commit applies and changes the result.
- `conflict`: git cannot merge it. The run stops here: `outcome: 'conflict'` and `stoppedAt` (the position), with the conflicted paths and up to 10 files' merged text (with markers). Later steps are `not-run`.

Response: `{ onto, outcome, stoppedAt?, issues, warnings, steps, changedPaths }`. `changedPaths` lists what the picks change on `onto`, up to the stop. Each step is `{ index, commit, status, files, conflictedPaths, conflictedFiles, messages }`. The result is cached by `onto`'s commit and the list of commits, unless it holds more than 1 MB of conflicted text.

## Removed

These were removed; their replacements are in parentheses.

- `POST /api/compare/directories`, `GET /api/compare/files` (Folder Compare reads `POST /api/git/compare-trees`; file diffs read `POST /api/git/diff`).
- `POST /api/snapshot/file-diff` (`POST /api/git/diff` for the hunks, `POST /api/git/blame` for attribution).
- `POST /api/upstream/commits`, `…/applicability` and `…/patch` (`POST /api/git/log`, `…/show`, `…/merge-tree`, `…/ancestry` and `…/patch-equivalents`, combined in the browser, see [frontend](frontend.md)).
- Path sources: every side is a git source. Recent comparisons (`recent` in `SessionDetail`).

## Other

OM has no default folders: `GET /api/defaults` and `OM_LEFT`/`OM_RIGHT` were removed with the example data (decision 25).
