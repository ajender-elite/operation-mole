# Architecture

OM is a small monorepo (pnpm workspace) with a TypeScript API, a React single-page app, and a shared package of types and validation.

```
┌────────────── Browser ───────────────┐        ┌──────────────────── apps/server (Fastify) ────────────────────┐
│ apps/web (React 19 SPA)              │  /api  │ app.ts  routes + validation (zod) + error mapping            │
│  routes ─ pages ─ components          │ ─────▶ │   ├─ compare/   walk two folders, byte-compare, sort         │
│  TanStack Query cache                 │        │   ├─ files/     read a file for the diff view                │
│  URL search params = view state       │        │   ├─ git/       GitService (git CLI) + RepoManager (sessions) │
│  Monaco diff (lazy-loaded)            │        │   ├─ snapshot/  file diffs, blame attribution, renames       │
│  attribution aggregation (lib/)       │        │   ├─ upstream/  commit window, applicability (merge-tree)    │
│                                       │        │   └─ store/     Store (node:sqlite)                           │
└───────────────────────────────────────┘        └──────────────┬──────────────────────────────┬──────────────────┘
                 ▲ packages/shared: types + zod schemas used by both ▲   │                      │
                                                                         ▼                      ▼
                                                         .data/om.db (SQLite)    .data/users/<u>/sessions/<s>/… (clones, worktrees)
```

## Packages

| Package           | Role                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | `api.ts` (response types), `schemas.ts` (zod request schemas) and `response-schemas.ts` (zod response schemas, used by the web client to validate every response). Exported as TypeScript source. |
| `apps/server`     | Fastify API. Node runs the `.ts` files directly (type stripping), so there's no build step. Settings come from `config/server-config.ts`, which validates the environment (see `.env.example`).   |
| `apps/web`        | React app built with Vite. In development, Vite proxies `/api` to the API server.                                                                                                                 |

## Request flows

### Compare two sources (`POST /api/compare/directories`)

1. The body is validated by `DirectoryCompareRequestSchema`. A bare absolute path is shorthand for `{type: 'path', path}`.
2. Each side is resolved by `RepoManager.resolve`:
   - **path:** the folder itself.
   - **git:**
     1. Check that the session belongs to the user and that the repo is in the session.
     2. `GitService.checkout` makes sure the branch's worktree folder is at the branch tip, creating or updating it (one git operation per repo at a time).
     3. The label is `repo @ branch`, and `.git` is ignored at that side's root.
3. `compareDirectories` walks both roots in parallel, at most 32 filesystem operations at a time. It compares files byte by byte, stopping at the first difference, and sorts each level. See [comparison rules](comparison-rules.md).
4. If a user and session were given, the comparison is recorded in the session's recent list.
5. The response holds the tree, the summary counts, both absolute roots (used to build file paths for the diff view), and both labels.

### Clone a repo (`POST …/repos`)

1. The URL is validated and normalized (trailing slashes removed).
2. If the session already has that URL and its clone exists on disk, it's returned as is (`200`).
3. Otherwise git makes a bare clone without file contents (`--filter=blob:none`), the branches are listed, the repo is saved, and the response is `201`.

See [git integration](git-integration.md).

### File diff (`GET /api/compare/files`)

1. Each side is read by `readFileForDiff`: size, SHA-256, and a binary check (a NUL byte in the first 8 KB).
2. Text content is included up to 5 MB.
3. `identical` comes from a byte comparison.
4. The web app renders the result in Monaco's diff editor, or a summary for binary or oversized files.

### Snapshot file diff (`POST /api/snapshot/file-diff`)

1. Both git sides resolve to commits (`RepoManager.resolveSnapshot`, no checkout needed).
2. `SnapshotAnalyzer.fileDiff` reads each side's entry (`git ls-tree`, `git cat-file`), decides text/binary/too-large, and runs `git diff` on the two blobs through an [object view](git-integration.md#analysis-commands) (the two sides may live in different clones).
3. Changed lines are blamed on their own side (`git blame --porcelain -L …`), after prefetching that file's history in one request for blob-less clones. Each commit gets its reachability from both snapshots (`git merge-base --is-ancestor`, cached).
4. The result is cached by `(left commit, right commit, paths, context)`.

Folder attribution is assembled in the browser from these per-file results (see [frontend](frontend.md#attribution)).

### Upstream applicability (`POST /api/upstream/applicability`)

1. Upstream resolves to a commit; downstream resolves and is checked out (so a blob-less clone has its file contents).
2. `UpstreamAnalyzer` lists the files the commit changes, prefetches both versions, and checks `merge-base --is-ancestor` (reachable → represented).
3. Otherwise `git merge-tree --write-tree --merge-base=<first parent> <downstream> <commit>` runs with a scratch object directory; the result tree is compared with downstream's, conflicts are excerpted, and `git log --cherry-mark` looks for patch-equivalent downstream commits (20 s limit).
4. The scratch directory is removed whatever happens. Results are cached by `(commit, downstream commit)`.

## Error handling

The server throws typed errors, and `app.ts` turns them into HTTP responses with a `{ message }` body:

| Error                                                                              | HTTP |
| ---------------------------------------------------------------------------------- | ---- |
| `CompareInputError` (bad input, bad path, git clone/fetch failure, unknown branch) | 400  |
| `NotFoundError` (session, repo or file not found)                                  | 404  |
| `ConflictError` (duplicate session name)                                           | 409  |
| anything else                                                                      | 500  |

The web client shows `message`. When the API can't be reached (network error, or the dev proxy answers 502/503/504), it shows a "Can't reach the OM API server" message instead.

## Security boundary

OM is meant for one machine or a trusted network:

- **Network:** the API binds to `127.0.0.1` by default.
- **Accounts:** there are no passwords; a username is just a namespace.
- **File access:** the API reads any local path it's given, with the server's own permissions.
- **Git:** URLs and the environment git runs with are restricted. See [git integration](git-integration.md#security).
