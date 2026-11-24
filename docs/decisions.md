# Decisions

Key choices and their trade-offs. Add an entry when you make a decision that someone might later want to reverse.

### 1. Local server, not browser-only

**Decision:** a Node API reads folders and runs git; the browser only displays results.
**Why:** it handles large folders and real paths, git needs a real filesystem and the machine's credentials, and byte comparison is fast server-side.
**Trade-off:** anyone who can reach the API can read local files with the server's permissions, so it binds to `127.0.0.1` by default.

### 2. Match by relative path; byte-for-byte equality

**Decision:** entries are paired by relative path and are equal only if their bytes are identical. A rename shows as one entry only in left and one only in right.
**Why:** this is what was asked for, and it's predictable.
**Trade-off:** no rename detection for folder sources. _Select for compare_ covers diffing two files with different names. (Superseded for git sources by decision 15.)

### 3. A file and a folder with the same name are two entries

**Decision:** they're listed as two one-sided entries rather than one "modified" entry.
**Why:** they can't be compared, and "modified" suggested a diff that doesn't exist.

### 4. Folders first, natural case-insensitive order, fixed locale

**Decision:** `Intl.Collator('en', { numeric: true, sensitivity: 'base' })` plus a code-point tie-break, applied on the server only.
**Why:** this is the order users asked for. A fixed locale gives the same order on every machine.

### 5. Username-only identity

**Decision:** no passwords; a username is just a namespace for sessions.
**Why:** OM is a local or trusted-network tool, and accounts would add friction.
**Trade-off:** anyone who knows a username can open its sessions. Add real authentication before exposing OM more widely.

### 6. System git via simple-git; bare, blob-less clones with worktrees (worktrees removed by decision 27)

**Decision:** run the machine's `git` instead of a JavaScript git library. Each repo is a bare `--filter=blob:none` clone per session, with one worktree per branch (the worktrees were removed by decision 27).
**Why:** SSH keys and credential helpers work as they do in a terminal (isomorphic-git can't use SSH). Blob-less clones keep large repos fast, and worktrees let two branches of one repo be compared at once.
**Trade-off:** git must be installed on the server.

### 7. Fetching is manual

**Decision:** clones are reused as is; **Fetch latest** updates them.
**Why:** the user chose predictable, fast comparisons over always-current ones.

### 8. Node's built-in SQLite

**Decision:** `node:sqlite` for users, sessions, repos and recents.
**Why:** no native module to build and no separate database. It's reliable enough for a single-process local app.
**Trade-off:** requires Node 22.5 or later; the project targets 24+.

### 9. The URL holds view state

**Decision:** session, sources, branches, current folder and file paths are all in the URL.
**Why:** reloads must land in the same place (an explicit requirement), and links can be shared or bookmarked.

### 10. Run TypeScript directly on the server

**Decision:** Node's type stripping runs `apps/server` and `packages/shared` directly. TypeScript is used with `erasableSyntaxOnly`.
**Why:** no build step and no source maps to manage for the server.
**Trade-off:** no enums or parameter properties, and relative imports must use `.ts` extensions.

### 11. TypeScript pinned to 6.0

**Decision:** `typescript@~6.0`.
**Why:** typescript-eslint, needed for type-aware linting, didn't yet support TypeScript 7. Revisit when it does.

### 12. Monaco bundled locally

**Decision:** Monaco and its worker are bundled by Vite and lazy-loaded, with no CDN. (Since decision 22 no page renders it; decision 26 removed it.)
**Why:** works offline and avoids third-party requests. It's a large chunk, but only loaded when needed.

### 13. Names: OM, Left and Right

**Decision:** the app is **OM (Operation Mole)**. The UI calls the sides **Left** and **Right**; code and URLs keep `left`/`right`.
**Why:** the names describe each side's role. Keeping `left`/`right` in code avoided churn and kept old links working.

### 14. Snapshots are commits

**Decision:** a git side resolves to an exact commit; `branch` may also be a tag or a commit SHA. Every analysis (diffs, blame, applicability) runs on the resolved SHAs, and the UI pins follow-up requests to them.
**Why:** a branch moves after **Fetch latest**; the commit is the snapshot's identity, and results keyed by SHA can be cached forever.
**Trade-off:** a new worktree per pinned SHA when one is compared in Folders. (Superseded by decision 27: nothing is checked out any more.)

### 15. Rename detection for git sides, as links

**Decision:** for two git snapshots, git's rename detection links an only-in-base and an only-in-target entry (`renamedTo`/`renamedFrom`) instead of merging them into one entry.
**Why:** renames are reliably detectable from git, and the contract asks for them; keeping path-matching intact keeps statuses, counts and folder roll-up unchanged.

### 16. Attribution is git blame on each line's own side

**Decision:** `−` lines are blamed in Left's history, `+` lines in Right's, and each commit carries its reachability from both snapshots. OM calls these "divergence commits" and never "the cause".
**Why:** blame answers "which commit currently accounts for this line", which is the question OM can back with evidence. Reachability exposes shared history honestly.
**Trade-off:** content one side deleted has no blame on that side (see [investigation model](investigation-model.md#known-limits)).

### 17. Applicability with `git merge-tree` in a scratch object directory

**Decision:** each upstream commit is applied independently to the downstream commit with `git merge-tree --write-tree --merge-base=<first parent>`, with new objects written to a temporary `GIT_OBJECT_DIRECTORY` that is deleted afterwards.
**Why:** it is the real merge machinery (same conflicts as cherry-pick), needs no index or worktree, touches no refs, and leaves nothing behind, even on failure or cancellation.
**Trade-off:** needs git 2.38 or later (`merge-tree --write-tree`).

### 18. Analysis commands run without simple-git

**Decision:** `GitService.run` spawns git directly (no shell, the same environment allowlist) for analysis; clone, fetch and checkout stay on simple-git.
**Why:** analysis needs exit codes as answers (`merge-base --is-ancestor`, `merge-tree`), extra environment (object views) and abort signals, which simple-git doesn't expose.

### 19. Cross-remote analysis through alternates in the environment

**Decision:** to see two clones' objects in one git process, OM sets `GIT_ALTERNATE_OBJECT_DIRECTORIES` for that process.
**Why:** no fetching between clones, no `file://` transport, and no clone's config or objects change.

### 20. Folder attribution runs in the browser, file by file

**Decision:** the browser fetches each differing file's diff (4 at a time) and aggregates commits per folder; the server has no folder-attribution endpoint.
**Why:** results arrive incrementally, are cancellable, and share one cache with the file view, so opening a file after its folder was attributed is instant.

### 21. Lab became Upstream

**Decision:** the Lab placeholder route now hosts commit applicability; `/lab` links redirect.

### 22. The UI compares git repositories only, in one page

**Decision:** each side of a comparison is a repository URL (or a repo already cloned in the session) plus a branch the user picks explicitly; local folders are no longer offered. The old Files page is gone and `/files` links redirect to Folders (files now open in a File Compare tab, see decision 23).
**Why:** Left and Right may live on different remotes, so the repository must be explicit, and a silently preselected default branch hid what was being compared. One page keeps navigation in one place (tree → file → back) instead of jumping between experiences.
**Trade-off:** no comparison of two local folders, and no diff of two files with different names (_Select for compare_ is gone), in the UI. The server still accepts path sources and `GET /api/compare/files`. The Monaco `DiffView` is no longer rendered by any page.

### 23. Working contexts as tabs; explanation on request

**Decision:** inside a session, the Overview, each Folder Compare, File Compare and Upstream analysis is a tab. Tabs stay mounted once visited (hidden with `visibility: hidden` and `inert`), each rendered from its own URL with `<Routes location>`; an equivalent context focuses its open tab instead of opening a duplicate. Folder Compare and File Compare show only the difference: attribution is computed when the user asks ("Explain difference"), for what they asked about, and `POST /api/snapshot/file-diff` can skip `git blame` (`attribute: false`).
**Why:** drilling from a comparison into a file and back should not lose the tree, filters or scroll position, and should not compete with the comparison for space. "What is different" is the first question; "what accounts for it" is secondary, costs a blame per file, and was visually noisy when shown by default.
**Trade-off:** hidden tabs keep their DOM and queries in memory. Only the active tab's URL is in the address bar; other tabs are restored from `sessionStorage`, so they don't travel with a copied link. The panel no longer follows focus by itself: the user asks again for a different folder or file.

### 24. Releases are built artifacts, not committed builds

**Decision:** `pnpm release` writes `releases/om-<version>/` and a `.tar.gz` (ignored by git): the server and shared TypeScript source in the repository layout, the built web app, and the production dependencies as one flat `node_modules` from the lockfile. It runs with `node apps/server/src/index.ts --production`, with nothing to install or build.
**Why:** the server needs no build, and its dependencies are plain JavaScript, so one archive runs on Linux, macOS and Windows. Committing `dist` instead would add megabytes to history per release, go stale against the source, and conflict between branches.
**Trade-off:** the target still needs Node 26+ (type stripping, `node:sqlite`) and git. A dependency with a native addon would make releases OS-specific; the script refuses that rather than ship it silently.

### 25. A real repository (nginx) replaces the example folders

**Decision:** the end-to-end comparison test uses nginx's `stable-1.26` and `stable-1.28` branches, from a 1.4 MB bundle in `test/seed/`, through the API as the app uses it. `examples/left` and `examples/right` are gone, with their test, `postinstall` script and tooling exceptions, and so are `GET /api/defaults` and `OM_LEFT`/`OM_RIGHT`, which only pointed at them. The byte-level and sort-order edge cases the examples held (CRLF, trailing spaces, empty and binary files, symlinks, accents, numeric names) are temp-folder tests in `compare-directories.test.ts` and `sort.test.ts`.
**Why:** OM compares git repositories only, so its main test should be a real repository compared branch to branch, not two hand-made folders. Edge cases are clearer as small, named tests next to the code than as files in a shared sample tree that had to stay byte-exact.
**Trade-off:** the bundle holds nginx's trees, not its history (two fixture commits), so attribution and applicability tests stay on the small, controlled Hello-World scenarios. Live GitHub checks run only under `pnpm test:remote`.

### 26. Monaco removed

**Decision:** the Monaco diff view (`DiffView`), its loader, the language helper and the `monaco-editor` and `@monaco-editor/react` dependencies are deleted. Diffs are shown from the hunks the git primitives return (`SnapshotDiffView`).
**Why:** no page had rendered Monaco since decision 22, so its bundle and worker were dead weight. The hunk view already does the job, with blame and attribution markers that Monaco could not place.
**Trade-off:** Monaco’s own editing and search features are gone. The diff is read-only either way.

### 27. Git primitives on trees; no checkouts; the legacy routes removed

**Decision:** comparisons read the trees of two commits (`compare-trees`, `diff`, `blame`, `log`, `show`, `merge-tree`, `patch-equivalents`) and never a checkout. The folder and file routes (`/api/compare/*`), the file-diff route and the upstream routes are removed, and so are path sources, recent comparisons and worktrees. Attribution and applicability are composed in the browser from the primitives (decision 20 moved folder attribution there; this moves the rest).
**Why:** a checkout per side writes a folder for every comparison, and the same questions answer from the object database with less I/O. Each question is one git call with a test, and the browser decides what the answers mean, which is where the UI rules live.
**Trade-off:** a diff or a blame first fetches its blobs in one batch (a network round trip in a blob-less clone). Links to the removed API routes stop working, and recent comparisons are not kept.
