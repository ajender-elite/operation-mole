# Testing

OM is built **test-first**: write or extend a test, watch it fail for the right reason, then implement. `pnpm check` (type check, lint, format check and all tests) must pass before a change is done.

```bash
pnpm test                                                    # everything
pnpm vitest run --project server                             # one project: shared | server | web
pnpm vitest run --project web src/pages/sessions-page.test.tsx # one file
pnpm test:watch                                          # watch mode
```

Vitest runs three projects, set up in the root `vitest.config.ts`:

| Project  | Environment | Location                          |
| -------- | ----------- | --------------------------------- |
| `shared` | node        | `packages/shared/src/*.test.ts`   |
| `server` | node        | `apps/server/test/*.test.ts`      |
| `web`    | jsdom       | `apps/web/src/**/*.test.{ts,tsx}` |

## Server tests: real files, real git

There are no mocks of the filesystem or git, because the edge cases are in how real files and git behave.

| File                         | Covers                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-fixtures.ts`            | `createOrigin()` makes a repo with `main`, `dev` and `feature/x`; `commit()` and `git()` helpers. Git runs with an isolated config.                              |
| `tree-compare-rules.test.ts` | Folder Compare rules on leaf maps (no disk): every status, same-id content, one-sided folders, propagation, file/folder name clashes, natural order, POSIX paths |
| `sort.test.ts`               | sort order (symbols, dots, numbers by value, case, accents)                                                                                                      |
| `store.test.ts`              | sessions, repos, schema versions (in-memory SQLite, fixed clock)                                                                                                 |
| `git-service.test.ts`        | URL validation, clone, branches, resolving revisions, fetch, clone errors                                                                                        |
| `sessions-api.test.ts`       | HTTP endpoints through `app.inject`, including the folder comparison end to end                                                                                  |
| `nginx-branches.test.ts`     | a real repository end to end: nginx `stable-1.26` → `stable-1.28` (counts, statuses, order, file diff). Its data folder persists per machine (see below)         |
| `scenario.ts`                | `Scenario`: deterministic histories on the pinned seed; `nginxRepo()`: the nginx fixture (both below); `repoState()` snapshots a repo for safety checks          |
| `om-client.ts`               | `OmClient`: one user’s session over `app.inject` (folder compare, file diff, `startOrResume` for data kept between runs)                                         |
| `snapshot-compare.test.ts`   | snapshot identity (branch/tag/SHA), every file/folder state, renames, binary, too large, both directions, path validation                                        |
| `blame-primitives.test.ts`   | blame names the commit that last changed each line, per side; blob-less history fetched in one batch                                                             |
| `analysis-parsers.test.ts`   | diff, blame-porcelain and log parsers; the analysis cache’s LRU                                                                                                  |

Tests that need `file://` clones create the app with `allowedProtocols: ['https', 'ssh', 'file']`.

### The pinned seed and controlled histories

Analysis tests build on a small public repository without needing the network:

1. **Seed:** `test/seed/hello-world.bundle` is [octocat/Hello-World](https://github.com/octocat/Hello-World) frozen at commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` (a real merge commit with two parents). Tests use pinned SHAs, never `master` or "latest".
2. **Scenario:** `Scenario.fromSeed(dir)` makes a temporary repo at that commit; tests add exactly the commits they need (`commit`, `move`, `branch`, `cherryPick`, `merge`, `fork` for a second remote).
3. **Deterministic:** authors, committers, messages and dates are fixed (one hour apart from 2026-01-01), and git runs with no global or system config and no inherited `GIT_*` variables, so the developer's identity, aliases and hooks never matter.
4. **Realistic clones:** scenario repos serve partial clones (`uploadpack.allowFilter`), so OM's `--filter=blob:none` clones of them really are blob-less, as from GitHub, and lazy fetching and prefetching are exercised offline.

### The nginx fixture: a real repository, offline

`test/seed/nginx.bundle` (1.4 MB) lets `nginx-branches.test.ts` compare two branches of a real project: [nginx/nginx](https://github.com/nginx/nginx) `stable-1.26` (Left) and `stable-1.28` (Right). `nginxRepo(dir)` serves it as a bare repository with partial clones allowed, like GitHub.

Each branch is one fixture commit holding nginx's exact tree at a pinned release commit (`NGINX_1_26` and `NGINX_1_28` in `scenario.ts`), with `stable-1.28` a child of `stable-1.26`. The full history would be far too large, and a shallow copy can't serve blob-less clones. So the **trees** match GitHub's byte for byte (`test:remote` checks this), while the commit SHAs are the fixture's own. Between the two: 401 identical files, 101 modified, 2 only in Left, 11 only in Right.

To rebuild it (for example, for newer releases), in an empty folder with git's own config disabled (`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`):

```bash
git init -q --bare src.git && cd src.git
git fetch -q --depth=1 https://github.com/nginx/nginx.git <base-sha> <target-sha>
export GIT_AUTHOR_NAME="OM Fixture" GIT_AUTHOR_EMAIL=fixture@example.com
export GIT_COMMITTER_NAME="OM Fixture" GIT_COMMITTER_EMAIL=fixture@example.com
export GIT_AUTHOR_DATE="@1767225600 +0000" GIT_COMMITTER_DATE="@1767225600 +0000"
BASE=$(git commit-tree -m "nginx-<base> tree (nginx/nginx <base-sha>)" "<base-sha>^{tree}")
export GIT_AUTHOR_DATE="@1767229200 +0000" GIT_COMMITTER_DATE="@1767229200 +0000"
TARGET=$(git commit-tree -p "$BASE" -m "nginx-<target> tree (nginx/nginx <target-sha>)" "<target-sha>^{tree}")
git update-ref refs/heads/stable-<base> "$BASE"
git update-ref refs/heads/stable-<target> "$TARGET"
git bundle create nginx.bundle refs/heads/stable-<base> refs/heads/stable-<target>
```

Then update the constants in `scenario.ts` and the expectations in `nginx-branches.test.ts` and `remote/nginx.remote.test.ts`, and run `pnpm test:remote`.

### Remote smoke tests

`pnpm test:remote` (config `apps/server/vitest.remote.config.ts`, files `test/remote/*.remote.test.ts`) clones the real repositories over https. It checks that the pinned Hello-World commits still exist and match the seed bundle, and that the pinned nginx release commits hold exactly the fixture's trees and compare the same way. It needs the network, so it is never part of `pnpm test` or `pnpm check`.

### Any OS

The suite must pass on Linux, macOS and Windows. Don't branch on `process.platform`; probe the capability instead (`test/capabilities.ts`), and use `it.runIf(...)` with a comment saying where it's missing:

| Probe                    | False when                                                |
| ------------------------ | --------------------------------------------------------- |
| `canCreateSymlinks`      | Windows without Developer Mode or admin rights            |
| `canMakeFilesUnreadable` | Windows (`chmod` doesn't block reads), or running as root |

Prefer keeping a test running everywhere and only adding the platform-dependent part when the probe allows it (see the sort-order test). Build paths with `path.join`, never `'/'`. Server tests get a 30s timeout because spawning git is much slower on Windows.

## Web tests: the whole app, a mocked API

- **`renderApp(url)`** (`src/test/render.tsx`) renders the **real routes** in a memory router with a fresh query client. It returns `location()` and `search()` so tests can check the URL.
- **MSW** (`src/test/server.ts`, `src/test/setup.ts`) mocks the API. Unhandled requests **fail** the test (`onUnhandledFrame: 'error'`), so every request the page makes needs a handler, including the session `GET` the header makes. `src/test/handlers.ts` has shared fixtures (`sessionSummary`, `repoInfo`, `sessionDetailHandler`).
- **Setup:** `matchMedia` is stubbed (the app ignores it: the theme is dark unless the user chose light), and `localStorage` and `data-theme` are reset before each test.
- **Git investigation flows:** `folder-attribution.test.tsx` (focus → attribution, file/hunk/line, commit → differences, URL restore, large folders) and `upstream-page.test.tsx` (window, independent evaluation, evidence) mock the git primitives; `lib/attribution.test.ts` covers the aggregation rules.
- **Queries:** prefer role, label and text queries (`getByRole('treeitem', { name })`, `getByLabelText('Left branch')`). They double as accessibility checks.

## In the browser

`.claude/launch.json` defines `dev` (`pnpm dev` on port 5180) for the browser preview. Check visual and interaction changes there, in both themes and at a narrow width. Use a throwaway username, and delete its session afterwards so its clones are removed.
