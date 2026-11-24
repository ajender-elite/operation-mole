# Architecture

OM is a small monorepo (pnpm workspace) with a TypeScript API, a React single-page app, and a shared package of types and validation.

```
Browser (apps/web, React 19 SPA)                       API (apps/server, Fastify)
  routes, pages, components                              app.ts         routes, validation (zod), error mapping
  TanStack Query cache                                   compare/       folder rules on git trees, summary
  URL search params = view state                         git-api/       git primitives: log, show, blame, diff,
  lib/: attribution, applicability, file diffs                          merge-tree, compare-trees, patch-equivalents
        (composed from the primitives)                   git/           GitService (git CLI), RepoManager (sessions)
                                                         snapshot/      file diffs (hunks), renames, ancestry
        ◀── JSON over /api ──────────────────────────▶  cache/         analysis cache: memory, then SQLite
                                                         store/         Store (node:sqlite), one file per user
                                                                │                       │
                                                                ▼                       ▼
                                              .data/users/<u>/user.db      .data/users/<u>/sessions/<s>/… (clones)
```

## Packages

| Package           | Role                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | `api.ts` (response types), `schemas.ts` (zod request schemas) and `response-schemas.ts` (zod response schemas, used by the web client to validate every response). Exported as TypeScript source. |
| `apps/server`     | Fastify API. Node runs the `.ts` files directly (type stripping), so there's no build step. Settings come from `config/server-config.ts`, which validates the environment (see `.env.example`).   |
| `apps/web`        | React app built with Vite. In development, Vite proxies `/api` to the API server.                                                                                                                 |

## Request flows

### Folder Compare (`POST /api/git/compare-trees`)

1. Both git sides resolve to exact commits (`RepoManager.resolveSnapshot`). Nothing is checked out.
2. Each side's files are listed from its tree (`git ls-tree -r -l`). In a blob-less clone, the file contents the listing needs are fetched in one request first (`prefetchTree`).
3. Files are compared by object id, so a file is identical when its content is. The folder tree is built from the same leaves by the folder rules (`compare/git-trees.ts`): folders first, a file and a folder of the same name are two one-sided entries, and a difference marks only the folders above it.
4. Renames are detected (`git diff -M`) and marked on the tree. The response holds the flat entries, the renames, and the `folder` tree the page shows.

See [comparison rules](comparison-rules.md) for what each status means, and [git integration](git-integration.md) for the git side.

### Clone a repository (`POST /api/users/:user/sessions/:sessionId/repos`)

1. The URL is validated and normalized (trailing slashes removed).
2. If the session already has that URL and its clone exists on disk, it's returned as is (`200`).
3. Otherwise git makes a bare clone without file contents (`--filter=blob:none`), the branches are listed, the repo is saved, and the response is `201`.

### File diff (`POST /api/git/diff`) and attribution

1. Each file pair's hunks come from `SnapshotAnalyzer.fileDiff`: the side's entry is read (`git ls-tree`, `git cat-file`), text, binary and too-large are decided, and `git diff` runs on the two blobs through an [object view](git-integration.md#analysis-commands) (the two sides may live in different clones). The diff itself never attributes.
2. Attribution is asked for separately: `POST /api/git/blame` for each side's lines, and `POST /api/git/ancestry` for whether each commit is in the other side's history. The browser combines them (`lib/attribution.ts`, `lib/file-diff.ts`). See [frontend](frontend.md#attribution).

### Upstream analysis (composed in the browser)

The Upstream page has no server endpoint of its own. It is composed from the git primitives (`lib/upstream.ts`, `lib/applicability.ts`): `POST /api/git/log` for the commit window, `POST /api/git/show` for a commit's patch, and `POST /api/git/ancestry`, `POST /api/git/merge-tree` and `POST /api/git/patch-equivalents` for each commit's applicability. Each commit is evaluated on its own against the same pinned downstream commit. See [investigation model](investigation-model.md#applicability-states) for what each status means.

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
