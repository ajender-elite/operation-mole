# Frontend

Code: `apps/web/src`. Built with React 19, Vite 8, Tailwind CSS v4, TanStack Query 5, React Router.

## Routes

| Path                             | Page                   | Purpose                                                                                                                                                                                                                       |
| -------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                              | `WelcomePage`          | Enter a username (skipped if one is remembered)                                                                                                                                                                               |
| `/u/:user`                       | `SessionsPage`         | List, create and delete sessions; switch user                                                                                                                                                                                 |
| `/u/:user/s/:sessionId`          | `SessionOverviewPage`  | Add a repo (all it shows when there is none); then compare, repos with Fetch latest                                                                                                                                           |
| `/u/:user/s/:sessionId/folders`  | `DirectoryComparePage` | Folder Compare: what differs, as a tree; "Explain difference" on request                                                                                                                                                      |
| `/u/:user/s/:sessionId/file`     | `FileComparePage`      | File Compare: one file at the commits its Folder Compare resolved; "Explain difference" on request                                                                                                                            |
| `/u/:user/s/:sessionId/files`    | redirect to `folders`  | Files was folded into Folders (query kept)                                                                                                                                                                                    |
| `/u/:user/s/:sessionId/upstream` | redirect to `between`  | The Upstream page became Between (same branches, query mapped)                                                                                                                                                                |
| `/u/:user/s/:sessionId/lab`      | redirect to `between`  | The placeholder Lab, which became Upstream and then Between (no branches: Overview)                                                                                                                                           |
| `/u/:user/s/:sessionId/code`     | `CodePage`             | Code: one ref of a repo; folders and files; blame on each line (`blame=0` hides it); `lines=10-20` highlights                                                                                                                 |
| `/u/:user/s/:sessionId/commits`  | `CommitsPage`          | Commits: the commits of a ref, narrowed by message, author, path (following renames) or a range (`notIn`); the selected commit's patch beside them; `j`/`k` walk the list. `history`, `log` and `commits?side=` redirect here |
| `/u/:user/s/:sessionId/search`   | `SearchPage`           | Search: `git grep` over a ref, literal or regex, grouped by file; a hit opens Code at its line                                                                                                                                |
| `/u/:user/s/:sessionId/branches` | `BranchesPage`         | Branches: every branch and tag of every remote, ahead and behind the default branch                                                                                                                                           |
| `/u/:user/s/:sessionId/series`   | `SeriesPage`           | Series: picks, in order, checked on the chosen branches (`git cherry-pick` as a dry run)                                                                                                                                      |
| `/u/:user/s/:sessionId/between`  | `BetweenPage`          | Between: the commits on each side of two branches, marked only-left, only-right or picked across                                                                                                                              |
| `/directories`, `/files`         | redirect to `/`        | Links from before sessions                                                                                                                                                                                                    |

`AppShell` is the layout around every page. It shows the OM logo, the `user › session` breadcrumb, the session navigation (inside a session only) and the theme toggle. It gets the user and session from `useMatch`.

## The URL is the state

Everything needed to rebuild a view is in the URL, so reloads, bookmarks and Back/Forward work:

| What            | Where                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| User, session   | path (`/u/:user/s/:sessionId`)                                                                         |
| Left side       | `leftRepo=<repoId>&leftBranch=<branch>` (git only)                                                     |
| Right side      | `rightRepo=…&rightBranch=…`                                                                            |
| Current folder  | `path=sub/dir` (Folders)                                                                               |
| Explained scope | `explain=/`, `explain=dir/` or `explain=dir/a.ts` (Folders); `explain=1` (File)                        |
| File            | `leftCommit`, `rightCommit`, `leftPath`, `rightPath` (File; sources as above)                          |
| Focused hunk    | `hunk=<index>` (File; `full=1` for whole-file context)                                                 |
| Selected commit | `commit=<sha>` (Folders: details + footprint; Commit: the Patch or Branches pane with `pane=branches`) |

`lib/sources.ts` converts between the URL and `GitSource` objects (`sourceFromParams`, `sourcesSearch`; a side on another remote carries `leftRemote`/`rightRemote`, and origin is left out); `lib/urls.ts` builds tab URLs (`foldersUrl`, `fileUrl`, `commitUrl`, `commitsUrl`, `betweenUrl`, `codeUrl`, `historyUrl`, `searchUrl`, `branchesUrl`, `seriesUrl`).

### Tabs

`SessionWorkspace` (route `u/:user/s/:sessionId/*`) keeps the session's working contexts as tabs. Each tab is `{ id, url }` (`lib/workspace.ts`): the active tab's URL is the browser's, the others remember where the user left them. A tab is mounted on first visit and then stays mounted, rendered with `<Routes location={tab.url}>`, and inactive tabs are hidden with `visibility: hidden` and `inert` (not unmounted, not `display: none`), so expanded folders, filters, focus and scroll positions survive switching. The tab id is the comparison context: the two sources for Folder Compare and Between, the pinned commits and paths for File Compare, the repository and SHA for a Commit tab (`kind: commit`), the pinned File Compare plus a side for a Commits tab on a side (`kind: commits`), and the repository with its top and bottom revisions for a Range Log (`kind: log`) (`tabIdentity`, `IDENTITY` in `lib/workspace.ts`). `useWorkspace().open(url)` focuses the equivalent open tab as it was left, or opens a new one (`isExact` shows the given URL anyway; `isReplacing` puts the new context in the current tab's place). Tabs are kept per session in `sessionStorage` (`om-tabs:<user>:<session>`), so a reload restores them. The strip is shown only when more than the Overview is open. Between and Folders use the same `left*`/`right*` parameters, so the snapshots carry over between them.

The remembered username (`om-user`) and theme (`om-theme`) are in `localStorage`.

### Explorer tabs and the pick tray

The explorer tabs (Code, Commits, Search, Branches, Series, Between) take a repo and a ref: `repo=<id>&ref=<branch>&remote=<name>` (`refSourceFromParams`, `refParams`). Between takes `left=` and `right=` as `remote/branch`. A Code tab is one ref: moving between its folders keeps it. A Commits tab is one ref and path, so each folder opened has its own. A Series or Between tab is one repo, or one pair of branches.

The commits a series needs are collected in a **pick tray** (`lib/pick-tray.ts`): "Add to series" on a Commits row, a Between row or a commit adds the full SHA to a list kept in `sessionStorage` (`om-picks:<user>:<session>:<repo>`). The Series tab opens with that list when its URL names no picks. Once it is open, its URL (`picks=`, comma-separated, in order) is the source of truth, and every change writes the tray back.

### Shortcuts, go to file and checks in parallel

On a Code tab, `t` opens **Go to file** (`components/file-finder.tsx`): every path of the ref, filtered as you type by `lib/fuzzy.ts` (letters in order, scored by word starts, the file name and runs of letters). Enter opens the path in the same Code tab. `/` opens the Search tab for the same ref. `?` lists every shortcut (`components/shortcuts-dialog.tsx`, from the list in `lib/keys.ts`, which is also the single source for what each key does). Shortcuts are ignored while the user is typing in a field.

### Choosing a ref

Code and Commits show a **ref picker** (`components/ref-picker.tsx`) beside the repo name: a remote select when the repo has more than one remote, a branch-or-tag select over every ref of that remote (`lib/repo-refs.ts`, one `POST /api/git/refs` shared by the pages), and a commit SHA box. Choosing a ref opens the same page at that ref in a tab of its own, as the other links do.

### Blame panel: before this change

A blame tag's panel offers **Open commit**, **History of this file**, **View file at this commit** and **Blame before this change**. The last one opens the file at the commit's first parent, under the path it had then (`origPath` from blame, so a rename is followed). The parent is read from the commit's own metadata (`POST /api/git/show`, shared with the commit page), and a commit with no parent says it is the first commit of the file.

### Contained in, and comparing a folder

A commit's page lists the branches and tags of every remote that contain it (**Contained in**, from `POST /api/git/contains`, asked once per commit). A chip opens that ref's Code tab.

A folder's **Compare this folder with another ref** opens Folder Compare on that folder (`path=`), with the same ref on both sides: the user changes the other side. A file has no such action yet, because File Compare needs a pinned commit on each side.

### Syntax colours in compares and diffs

File Compare and the commit patch colour each line's tokens with the same Shiki theme as the Code tab (`lib/diff-highlight.ts`). The lines of a diff are tokenised together, as one text, so a string or comment that starts on one line is coloured on the next. A file with no grammar stays plain text.

The Series tab checks the chosen branches at most three at a time (`CHECKS_AT_ONCE`, through `usePooledQueries`). A result stays in the query cache, so reopening the series shows it at once.

### Source code

The code view highlights with Shiki (`lib/highlight.ts`: the fine-grained core with the JavaScript regex engine, so no WebAssembly). A grammar loads the first time a file of its language is shown, chosen by file extension. Token colours are CSS variables `--color-syntax-*`, defined in both themes in `index.css`, so the palette rules (contrast on the surface and the canvas) cover code too. A file with no grammar, over 200 KB, or over 5,000 lines shows as plain text.

## Data fetching

The client is `lib/api.ts`. It turns error responses into `ApiRequestError(message)`, and an unreachable API (including the dev proxy's 502) into a "Can't reach the OM API server" error.

| Query key                                                                                     | Data                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `['sessions', user]`                                                                          | sessions list                                                                                                                                                          |
| `['session', user, sessionId]`                                                                | `SessionDetail`, shared by the header, overview and source pickers                                                                                                     |
| `['compare-trees', user, sessionId, left, right]`                                             | the folder tree from `POST /api/git/compare-trees` (`staleTime: Infinity`; **Rescan** refetches)                                                                       |
| `['snapshot-file-diff', user, sessionId, left, right, leftPath, rightPath, full, attributed]` | one file's git hunks (`lib/snapshot-diff.ts`); `attributed: false` is the plain diff File Compare shows first, `true` the explained one shared with folder attribution |
| `['commit-patch', user, sessionId, repoId, sha]`                                              | a commit's patch                                                                                                                                                       |

Git sources in analysis keys are pinned to the commits the comparison or window resolved (`branch` = SHA), so cached results never describe a moved branch.

### Attribution

`lib/attribution.ts` holds the pure rules (unit-tested): `diffTarget`/`differingFiles` (rename pairs count once), `summarizeAttribution` (commits per scope, per side, one-sided before shared history), `commitFootprint` (where a commit accounts for differences). `lib/pooled-queries.ts` runs many cached queries 4 at a time with progress and cancellation; folder attribution (`useDirectoryAttribution`) and the series checks use it. `useAnalyzedDiffs` reads every file diff analyzed so far for "where else does this commit account for differences".

`lib/session.ts`'s `useRepoActions` provides the clone and fetch mutations. They put the returned `RepoInfo` straight into the cached session, then refetch it.

## Main components

| Component          | Notes                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompareForm`      | Two `SourcePicker`s, a swap button and Compare. It's remounted (via `key`) whenever the URL's sources change.                                                                                                                       |
| `SourcePicker`     | Folder / Git repo toggle; folder path; repo select with **Add a repository…** (URL + Clone); branch select; **Fetch latest**. Its draft type and helpers are in `lib/source-draft.ts`.                                              |
| `CompareTree`      | Rows for Left and Right from one flat list (`lib/tree.ts` `flattenTree`), so both sides stay aligned. Treeitem roles, keyboard support (Enter, arrow keys), hover actions.                                                          |
| `SnapshotDiffView` | Git's hunks for one file, Left → Right, with line numbers on both sides, an attribution chip per changed line (dashed when the commit is in both histories), hunk/line focus (`n`/`p`, `j`/`k`), and dimming for a selected commit. |
| `AttributionPanel` | "What accounts for this difference" for what the user asked to explain (repository, folder, file, hunk, line), progress for folders, commit details with its footprint, and a close button.                                         |
| `ThemeToggle`      | Switches dark (the default) and light (`lib/theme.ts`, a `useSyncExternalStore` store). It sets `html[data-theme]`; the saved choice wins, and the system setting is not consulted.                                                 |
| `Logo`             | The OM mole (`public/favicon.svg`), also used as the browser-tab icon.                                                                                                                                                              |

## Styling

Tailwind v4 with design tokens in `src/index.css` (`@theme`):

- **Colors:** `--color-side-left*` (green), `--color-side-right*` (blue), `--color-modified*` (orange), `--color-error*` (red), plus surface, line, muted and accent tokens.
- **Dark by default:** the `@theme` block holds the dark palette. Light is `:root[data-theme='light']`. The system preference is not used.
- **`dark:` variant:** matches unless the user chose light.

### Attribution is composed in the browser

A file’s diff in File Compare, and in the folder attribution that opens files, comes from `lib/file-diff.ts`, which asks the backend git questions and decides what they mean here:

- `POST /api/git/diff`: the hunks, without commits.
- `POST /api/git/blame` (only when attribution is asked for): for each changed line, the commit that last changed it on its own side (Left’s lines for removed lines, Right’s for added ones).
- `POST /api/git/ancestry`: whether each such commit is in Left’s and in Right’s history, which marks it as shared or one-sided.

The result has the same shape as before, so the views and `lib/attribution.ts` are unchanged. Attribution is still shown as “what accounts for this difference” and never as the cause.

### Between and series: composed from the git primitives

Between (`pages/between-page.tsx`) is one `POST /api/git/patch-equivalents` (the commits on each side, marked as only-left, only-right or picked across) with `POST /api/git/refs` for the branch choices. A series check (`components/series-verdict.tsx`: the Series tab and a commit’s Branches pane) is one `POST /api/git/cherry-pick` per branch, at most three at a time (`usePooledQueries`); the server merges each pick on the result of the one before and stops at the first conflict. A conflict is never described as “missing”, and a clean apply is never described as “safe”.

The server no longer has `/api/upstream/*` or `/api/snapshot/file-diff`: the browser composes the same answers from the git primitives above.

### Colour and eye comfort

The palette is warm charcoal in dark and warm paper in light, with no pure black or white and softened status colours, so long reading sessions are gentle. `lib/palette.test.ts` reads `index.css` and enforces the rules:

- Text on every surface it is drawn over is at least **4.5:1** (WCAG AA).
- Status marks (`*-dot`) are at least **3:1** against the surface.
- Dark body text stays **below 13:1** to avoid glare.
- Every token exists in both themes, and neither uses `#000000` or `#ffffff`.

Meanings are fixed: green = only in Left (left), blue = only in Right (right), orange = different, red = error. Hairline dividers (`--color-line`) are decorative and exempt from the 3:1 rule.

### File Compare, Commit and Commits

- **Layout.** File Compare opens **side by side**: Left (blue) on the left, Right (green) on the right, aligned row by row (`lib/diff-rows.ts`, `alignRows`). **Inline** is the single list with `+`/`−` lines. The choice is `view=inline` in the URL, so it survives a reload and a tab switch. The focused hunk and line persist across the switch.
- **Commit markers.** A changed line's commit marker opens that commit in its own **Commit tab** (`commit` kind). The commit's repository is the repository of the side whose history holds it (Left for removed lines, Right for added). The File Compare tab is not replaced.
- **Blame.** **Blame Left** and **Blame Right** (`blame=left`, `right` or `left,right` in the URL) mark every line of a side, context lines included, with the last change to that line in that side’s own history (`POST /api/git/blame` on that side’s commit). A commit the other side also has (`POST /api/git/ancestry`) is drawn dashed. The marker is labelled as the last change in that history, not as the cause, and it opens the commit as a commit marker does. A blamed side takes the place of the Explain commit column for that side.
- **Identical content.** Both panes show the whole text (one context hunk, from the full-file diff, asked for only once the file is known to be identical). Both sides' blame is loaded, and a line whose last change is a different commit on each side is marked, counted in a status line, and reached with **Previous difference** and **Next difference**.
- **Diverging commits.** "Left: diverging commits" and "Right: diverging commits" open a **Commits** tab on that side's commit, excluding the other side's (`ref`, `notIn`). The old Commit List URL (`commits?side=`) redirects to it.
- **Commit tab.** One commit as a reader wants it: its message (links clickable), author and dates, its SHA (copy), its parents (each opens its own Commit tab), and a **Log from here down to…** form that opens a Commits tab over the range. Its files are summarized (with line counts; a filter; tapping one jumps to it) and each file is a collapsible diff, collapsed when there are more than 10. The data comes from `POST /api/git/show` and `POST /api/git/log`.
- **Range.** A range is a Commits tab with `ref` (the top) and `notIn` (the bottom); the old Range Log URL (`log?top=&bottom=`) redirects to it.
- **Back and forth.** Each new tab is opened in the background; "File compare" in a Commits tab returns to the File Compare tab as it was left.

### Responsive layout

OM works on phones (Android Chrome first) in portrait and landscape, and on tablets and desktops.

- **Breakpoints** (`lib/media.ts`, `MEDIA`): `compact` is `max-width: 639px`, `short` is `max-height: 480px` (a phone in landscape), `coarse` is `pointer: coarse` (touch), and `wide` is `min-width: 1024px` (where panels sit side by side).
- **CSS variants** (`index.css`): `coarse:` and `short:` are Tailwind variants with the same thresholds. Use them for CSS-only changes; choose layouts in JS with `useMediaQuery` when the markup itself differs.
- **Touch targets:** the `touch-target` utility extends a small control's tappable area to at least 40px on coarse pointers without changing how it looks.
- **Clipboard:** `lib/clipboard.ts` `copyText` falls back to a selected textarea when the async Clipboard API is missing (plain http to a LAN address).
- **Overflow:** the app shell's `main` clips, so a page never scrolls sideways as a whole; code and tables scroll in their own containers.
- **Tests:** `stubViewport({width, height, pointer, dark})` (`src/test/setup.ts`) makes `matchMedia` and `innerWidth` answer for a chosen screen, so a test can render a phone, a landscape phone or a desktop.
- **Toolbar** (`components/toolbar.tsx`): primary actions always show; secondary ones move into **More** on a phone or in landscape, and choosing one closes the menu.
- **Sheet** (`components/sheet.tsx`): explanation and commit details are columns on wide screens and full-height sheets below `lg`. Escape closes them, and a Back bar appears when a `backLabel` is given. The open state stays in the URL (`explain=`, `commit=`), so the back gesture closes them and a reload restores them.
- **Tab strip:** a fade on the right shows more tabs to scroll to; the **Tabs** menu lists every open tab and can switch to or close any of them. On a phone the close buttons are always visible, and tabs are narrower below `sm`.
- **Landscape (`short`):** the header and the session's tab strip share one row (the strip moves into the header's middle slot, `components/header-slot.tsx`). The Folder Compare sources line and breadcrumb are tighter. The Folder Compare toolbar uses `Toolbar`, so its secondary actions move into More.
- **Touch (`coarse`):** one tap on a file opens it and one tap on a folder expands it. Row actions stay visible without hover. A commit marker opens a small details popover (subject, author, date) with an **Open commit** button. The diff has **Next change** and **Previous change** buttons, standing in for `j`/`k`. Labels that may be cut short (the File Compare path, the diff column labels) are `FullText`: with a mouse the full text is in the tooltip, and on touch tapping shows it in a popover.
- **Diffs on a phone:** File Compare opens **inline** below 640px unless the URL says `view=side`, and keeps the choice in the URL either way. **Wrap lines** (`wrap=0` in the URL) makes long lines scroll sideways in their pane instead of wrapping. The gutters are narrower below 640px, and hunk headers stick under the column header.
