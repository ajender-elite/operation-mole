# CLAUDE.md

Guidance for Claude (and other coding agents) working in this repo. Read this first, then the topic docs in [docs/](docs/README.md).

## What this is

**OM (Operation Mole)** is a local web app for comparing a **Base** and a **Target**: two git branches cloned into a per-user **session** (the API also accepts two absolute folder paths; the UI offers only git). It shows what is identical, different, or present on only one side, and has a Monaco file diff.

- Users identify by **username only** (no passwords). Sessions belong to a user. Each session has its own cloned repos and a list of recent comparisons.
- Experiences, each in its own **tab** inside the session (`components/session-workspace.tsx`): **Overview** (add a repo first; then compare, recent, repos), **Folder Compare** (what differs), **File Compare** (one file at pinned commits), **Upstream** (commit applicability). Show only what the current state can use; attribution ("Explain difference") is computed only on request, scoped to what the user is looking at. The UI compares git repositories only: each side is a repo URL (sides may use different remotes) plus an explicitly chosen branch. The model and its git semantics are in [docs/investigation-model.md](docs/investigation-model.md); keep them precise.

## Commands

```bash
pnpm install               # once (pnpm only: never npm/yarn; CI uses --frozen-lockfile)
pnpm dev                   # API :5181 (node --watch) + web :5180 (Vite). Open http://localhost:5180
pnpm check                 # typecheck + eslint (0 warnings) + prettier --check + all tests. Must pass.
pnpm test                  # all Vitest projects (shared, server, web)
pnpm test:coverage         # tests + 80% line/branch thresholds
pnpm test:remote           # network: checks the pinned seeds (Hello-World, nginx) against GitHub (not part of check)
pnpm vitest run --project server test/git-service.test.ts   # one file
pnpm build && pnpm start   # production: one server on :5181
pnpm release               # releases/om-<version>/ + .tar.gz: runs anywhere with Node 26+ and git, no install or build
```

Rules for all code are in [CONTRIBUTING.md](CONTRIBUTING.md) (TypeScript guidelines, plus OM's documented deviations). Read it before writing code.

To check something in the browser, start `.claude/launch.json` → `dev` with the preview tool.

## Layout

```
packages/shared   API types (api.ts), request schemas (schemas.ts), response schemas (response-schemas.ts). TS source, no build.
apps/server       Fastify. Node runs .ts directly (type stripping). No build step.
  src/index.ts          entry: loads config, starts the server
  src/config/           server-config.ts: env vars + flags, validated with zod (the only place env is read)
  src/app.ts            all routes + error mapping (CompareInputError→400, NotFound→404, Conflict→409)
  src/compare/          folder walk, byte comparison, sort order (sort.ts)
  src/git/              git-service.ts (clone/branches/worktree/fetch, run() for analysis), repo-manager.ts (per-session dirs, locks, snapshots)
  src/snapshot/         snapshot-analyzer.ts (file diff + blame attribution, renames, ancestry), parsers, object views
  src/upstream/         upstream-analyzer.ts (commit window, merge-tree applicability, patches)
  src/store/store.ts    node:sqlite: users, sessions, repos, recent comparisons
  test/                 Vitest. Real temp folders and real git repos (git-fixtures.ts; scenario.ts: deterministic histories on the pinned Hello-World seed, and nginxRepo() with nginx stable-1.26/1.28; both bundles in test/seed/).
apps/web          React 19 + Vite + Tailwind v4 + TanStack Query + React Router + Monaco
  src/routes.tsx        / → Welcome, /u/:user → Sessions, /u/:user/s/:sessionId[/folders|/file|/upstream] inside SessionWorkspace tabs (/lab → upstream, /files → folders)
  src/components/, src/pages/   kebab-case files (app-shell.tsx), PascalCase components (AppShell)
  src/lib/              api client (parses every response with the shared schemas), sources (URL⇄Source), session hooks, tree, theme, format
  src/test/             MSW server + handlers, renderApp(url) helper
docs/             architecture, API, data model, git, comparison rules, frontend, testing, decisions
```

## How to work here

- **Write tests first.** Write or extend a test, run it and watch it fail for the right reason, then implement. Every behavior change comes with a test.
  - Server: `apps/server/test/*.test.ts`
  - Web: `*.test.tsx` next to the component or page, using `renderApp(url)` and MSW handlers
  - Real-world comparison: `nginx-branches.test.ts` (nginx `stable-1.26` → `stable-1.28`)
- **Finish with `pnpm check` passing.** For UI changes, also look at it in the browser preview.
- **TypeScript is strict** (every flag in CONTRIBUTING.md §4, including `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature`), with `erasableSyntaxOnly`. That means:
  - no `enum`, no constructor parameter properties, no namespaces
  - relative imports use `.ts`/`.tsx` extensions
  - no non-null assertions (`!`) and no `as` casts in production code; use a guard or parse with zod
  - `type`, not `interface`; exported functions have explicit return types; booleans are `is/has/can/should/did/will…`
  - files are kebab-case; zod schemas are PascalCase (`SourceSchema`)
  - eslint is `strictTypeChecked` + `stylisticTypeChecked` + unicorn, with `--max-warnings=0`
- **Untrusted input is parsed with zod:** request bodies and params (`app.ts`), env (`config/server-config.ts`), database rows (`store.ts`), and API responses in the web client (`response-schemas.ts`).
- **TypeScript is pinned to exactly 6.0.3**, because typescript-eslint doesn't support 7 yet. Don't bump it until it does.
- **Platform-agnostic:** code, package scripts, tests and docs must work on Linux, macOS and Windows.
  - Build paths with `path.join`/`fileURLToPath`, never by concatenating `'/'`. Paths users type may be `/…`, `C:\…` or `\\server\share`.
  - Package scripts run in cmd.exe on Windows: no `VAR=value cmd`, `rm -rf`, `&&`-chained shell tricks or globs. Use flags or a small `scripts/*.ts`.
  - Tests probe capabilities (`apps/server/test/capabilities.ts`), never `process.platform`. See [docs/testing.md](docs/testing.md#any-os).
  - Git runs with the server machine's own git config. Pass new env variables through the allowlist in `git-service.ts`; don't override user config (e.g. `core.sshCommand`).
- **Use React 19 event types:** `SubmitEvent<HTMLFormElement>`, not the deprecated `FormEvent`.
- **Libraries:** prefer well-known, stable ones. Adding a dependency is a deliberate choice; mention it.

## Domain rules (keep these true)

- **Statuses:**
  - `identical`, `modified`, `only-left`, `only-right`, `error`. In the UI, _left_ is **Base** and _right_ is **Target**; code and URLs keep `left`/`right`.
  - A folder is `identical` only if everything inside it is identical. A folder on both sides with differences inside is `modified`, shown with an orange dot.
  - A **file and a folder with the same name** are listed as two separate one-sided entries, never `modified`.
- **Sort order:** all folders first, then files. Within each group, `compareNames` in `apps/server/src/compare/sort.ts`: `Intl.Collator('en', {numeric: true, sensitivity: 'base'})`, with code-point order as the tie-break. The server sorts; the UI never re-sorts.
- **Colors:** green = only in base, blue = only in target, orange = different, red = error. Tokens are in `apps/web/src/index.css`.
- **URL is the state:** session in the path; each side as `leftRepo=<id>&leftBranch=<b>` (same for `right`; the UI ignores `left=/abs/path`); current folder as `path=`; what is explained as `explain=` (`/`, `dir/`, `file`). Each tab has its own URL; the active tab's is the browser's. Reload must restore the exact view.
- **Git:**
  - The system git runs through simple-git. Each repo is a bare `--filter=blob:none` clone per session, with one worktree per branch.
  - `.git` is ignored at the root of git sides.
  - Nothing fetches branches automatically; the user clicks **Fetch latest**. (Analysis does fetch missing file contents into blob-less clones, never refs.)
  - Analysis (diff, blame, log, merge-tree) goes through `GitService.run`, not simple-git; it must never write refs, the index or a worktree. `merge-tree` writes only to a scratch `GIT_OBJECT_DIRECTORY` that is always removed.
  - A git side resolves to an exact commit (branch, tag or SHA); analyses run on SHAs.
  - Attribution is `git blame` on each changed line's own side. Never present it as the historical cause; label shared-history commits.
  - Applicability evaluates each upstream commit independently against the same downstream commit. Never describe a conflict as "missing" or a clean apply as "safe".
- **Git security (don't weaken):**
  - URLs: https, ssh and scp-style only (`file://` only in tests via `allowedProtocols`).
  - Environment: `GIT_ALLOW_PROTOCOL`, `GIT_TERMINAL_PROMPT=0`, SSH `BatchMode`, and an allowlist of inherited variables (simple-git rejects others such as `GIT_EDITOR`).
  - Usernames are a strict slug; disk paths use generated ids, never raw input.
  - One git operation per repo at a time (lock in `RepoManager`).

## Pitfalls already hit

- **Ports:** 5173 is used by another project on this machine. OM uses **5180** (web) and **5181** (API).
- **`API_PORT`, not `PORT`:** the preview runner sets `PORT=5180`, so the API reads `API_PORT`. Don't switch it back.
- **Never kill node by name** (`pkill -f "node src/index.ts"`, `taskkill /IM node.exe`): it also kills the dev API, which runs that file under `node --watch`. Stop only the PID you started.
- **`pnpm start` passes `--production`**, not `NODE_ENV=production` (that syntax breaks on Windows).
- **The nginx fixture** (`test/seed/nginx.bundle`) holds nginx's exact trees at two pinned release commits, as two fixture commits (`stable-1.28` a child of `stable-1.26`). Commit SHAs are the fixture's own; tree SHAs match GitHub's, which `test:remote` checks. Rebuild it only as described in docs/testing.md, then update the constants in `scenario.ts` and the counts in `nginx-branches.test.ts`.
- **Long paths on Windows:** git refuses paths over 260 characters unless `core.longpaths` is on (nginx has them), so `GitService` passes `core.longpaths=true` to its simple-git commands. Keep it.
- **Monaco:**
  - It's bundled locally; the worker import is `monaco-editor/editor/editor.worker?worker` (0.57 exports map).
  - Keep `useInlineViewWhenSpaceIsLimited: false`, or narrow windows silently switch to inline.
- **MSW v3** uses `onUnhandledFrame` (not `onUnhandledRequest`). Unhandled requests fail tests, so every page test needs handlers for every request the page makes, including the session `GET` the header makes.
- **jsdom has no `matchMedia`:** `src/test/setup.ts` stubs it (light by default). `stubMatchMedia(true)` simulates dark mode.
- **No relative URLs in `fetch`:** jsdom's `fetch` rejects them, so the API client builds absolute URLs from `window.location.origin`.
- **Blob-less clones and blame:** blaming a file in a `--filter=blob:none` clone fetches its history one object at a time unless prefetched. Keep `prefetchMissing` before blame and merge-tree, and `gc.auto=0` on analysis (lazy fetches add packs; auto-repack under concurrent readers broke blame on a real repo).
- **Test scenarios serve partial clones** (`uploadpack.allowFilter`), so OM's test clones are blob-less like GitHub's. A test that reads objects directly from OM's clone must expect missing blobs.
- **Releases (`scripts/release.ts`):** Node won't strip types inside `node_modules`, so the release keeps `packages/shared/src` and `node_modules/@om/shared` is a JS re-export of it. Dependencies come from `pnpm deploy --prod` with `node-linker=hoisted` (flat, no symlinks); the script fails on symlinks or native addons, which would make the archive OS-specific. It runs pnpm via `npm_execpath` (a JS file or pnpm's standalone executable), never a `.cmd` shim.
- **Local data:** `.data/` holds the database and clones. It's in `.gitignore`. Delete it to reset local state.

## Docs to update when behavior changes

- [README.md](README.md): setup, run, usage
- [docs/](docs/README.md): design and reference docs (API, data model, comparison rules, …)
