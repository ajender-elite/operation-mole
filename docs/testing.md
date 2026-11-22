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

| File                                  | Covers                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures.ts`                         | `createWorkspace()` / `writeTree()` build folder trees (files, folders, symlinks, binary) in a temp folder                          |
| `git-fixtures.ts`                     | `createOrigin()` makes a repo with `main`, `dev` and `feature/x`; `commit()` and `git()` helpers. Git runs with an isolated config. |
| `compare-directories.test.ts`         | every status, name clashes, symlinks, errors, ignores, labels                                                                       |
| `files-equal.test.ts`, `sort.test.ts` | byte comparison; sort order                                                                                                         |
| `store.test.ts`                       | sessions, repos, recents (in-memory SQLite, fixed clock)                                                                            |
| `git-service.test.ts`                 | URL validation, clone, branches, worktrees, fetch, clone errors                                                                     |
| `app.test.ts`, `sessions-api.test.ts` | HTTP endpoints through `app.inject`, including git compares end to end                                                              |
| `examples.test.ts`                    | that `examples/` still covers every case and sort rule                                                                              |
| `scenario.ts`                         | `Scenario`: deterministic histories on the pinned seed (below); `repoState()` snapshots a repo for safety checks                    |
| `om-client.ts`                        | `OmClient`: one user's session over `app.inject` (compare, file diff, commits, applicability, patch)                                |
| `snapshot-compare.test.ts`            | snapshot identity (branch/tag/SHA), every file/folder state, renames, binary, too large, both directions, path validation           |
| `attribution.test.ts`                 | current vs historical attribution, hunk/file/folder scope, both sides, shared history, blob-less clones, two remotes                |
| `applicability.test.ts`               | the commit window and every applicability state, independence, patches, repository safety (success, conflict, failure, cancel)      |
| `analysis-parsers.test.ts`            | diff, blame-porcelain, log and conflict-excerpt parsers; LRU cache                                                                  |

Tests that need `file://` clones create the app with `allowedProtocols: ['https', 'ssh', 'file']`.

### The pinned seed and controlled histories

Analysis tests build on a small public repository without needing the network:

1. **Seed:** `test/seed/hello-world.bundle` is [octocat/Hello-World](https://github.com/octocat/Hello-World) frozen at commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` (a real merge commit with two parents). Tests use pinned SHAs, never `master` or "latest".
2. **Scenario:** `Scenario.fromSeed(dir)` makes a temporary repo at that commit; tests add exactly the commits they need (`commit`, `move`, `branch`, `cherryPick`, `merge`, `fork` for a second remote).
3. **Deterministic:** authors, committers, messages and dates are fixed (one hour apart from 2026-01-01), and git runs with no global or system config and no inherited `GIT_*` variables, so the developer's identity, aliases and hooks never matter.
4. **Realistic clones:** scenario repos serve partial clones (`uploadpack.allowFilter`), so OM's `--filter=blob:none` clones of them really are blob-less, as from GitHub, and lazy fetching and prefetching are exercised offline.

### Remote smoke tests

`pnpm test:remote` (config `apps/server/vitest.remote.config.ts`, files `test/remote/*.remote.test.ts`) clones the real repository over https and checks that the pinned commits still exist and match the seed bundle. It needs the network, so it is never part of `pnpm test` or `pnpm check`.

### Any OS

The suite must pass on Linux, macOS and Windows. Don't branch on `process.platform`; probe the capability instead (`test/capabilities.ts`), and use `it.runIf(...)` with a comment saying where it's missing:

| Probe                    | False when                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `canCreateSymlinks`      | Windows without Developer Mode or admin rights                                                   |
| `canMakeFilesUnreadable` | Windows (`chmod` doesn't block reads), or running as root                                        |
| `hasExampleSymlinks`     | git checked `examples/` out with `core.symlinks=false` (the Windows default): links become files |

Prefer keeping a test running everywhere and only adding the platform-dependent part when the probe allows it (see the sort-order test). Build paths with `path.join`, never `'/'`. Server tests get a 30s timeout because spawning git is much slower on Windows.

## Web tests: the whole app, a mocked API

- **`renderApp(url)`** (`src/test/render.tsx`) renders the **real routes** in a memory router with a fresh query client. It returns `location()` and `search()` so tests can check the URL.
- **MSW** (`src/test/server.ts`, `src/test/setup.ts`) mocks the API. Unhandled requests **fail** the test (`onUnhandledFrame: 'error'`), so every request the page makes needs a handler, including the session `GET` the header makes. `src/test/handlers.ts` has shared fixtures (`sessionSummary`, `repoInfo`, `sessionDetailHandler`).
- **Setup:** `matchMedia` is stubbed (light by default; use `stubMatchMedia(true)` for dark), and `localStorage` and `data-theme` are reset before each test.
- **Monaco** can't run in jsdom. `file-compare-page.test.tsx` swaps `DiffView` for a stub, and `diff-view.test.tsx` checks the options it passes to `DiffEditor`.
- **Git investigation flows:** `folder-attribution.test.tsx` (focus → attribution, file/hunk/line, commit → differences, URL restore, large folders) and `upstream-page.test.tsx` (window, independent evaluation, evidence) mock the snapshot and upstream endpoints; `lib/attribution.test.ts` covers the aggregation rules.
- **Queries:** prefer role, label and text queries (`getByRole('treeitem', { name })`, `getByLabelText('Base branch')`). They double as accessibility checks.

## In the browser

`.claude/launch.json` defines `dev` (`pnpm dev` on port 5180) for the browser preview. Check visual and interaction changes there, in both themes and at a narrow width. Use a throwaway username, and delete its session afterwards so its clones are removed.
