# Frontend

Code: `apps/web/src`. Built with React 19, Vite 8, Tailwind CSS v4, TanStack Query 5, React Router.

## Routes

| Path                             | Page                   | Purpose                                                                                            |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| `/`                              | `WelcomePage`          | Enter a username (skipped if one is remembered)                                                    |
| `/u/:user`                       | `SessionsPage`         | List, create and delete sessions; switch user                                                      |
| `/u/:user/s/:sessionId`          | `SessionOverviewPage`  | Add a repo (all it shows when there is none); then compare, repos with Fetch latest                |
| `/u/:user/s/:sessionId/folders`  | `DirectoryComparePage` | Folder Compare: what differs, as a tree; "Explain difference" on request                           |
| `/u/:user/s/:sessionId/file`     | `FileComparePage`      | File Compare: one file at the commits its Folder Compare resolved; "Explain difference" on request |
| `/u/:user/s/:sessionId/files`    | redirect to `folders`  | Files was folded into Folders (query kept)                                                         |
| `/u/:user/s/:sessionId/upstream` | `UpstreamPage`         | Upstream commit window and applicability to downstream                                             |
| `/u/:user/s/:sessionId/lab`      | redirect to `upstream` | The placeholder Upstream replaced (query kept)                                                     |
| `/directories`, `/files`         | redirect to `/`        | Links from before sessions                                                                         |

`AppShell` is the layout around every page. It shows the OM logo, the `user › session` breadcrumb, the session navigation (inside a session only) and the theme toggle. It gets the user and session from `useMatch`.

## The URL is the state

Everything needed to rebuild a view is in the URL, so reloads, bookmarks and Back/Forward work:

| What            | Where                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| User, session   | path (`/u/:user/s/:sessionId`)                                                  |
| Left side       | `leftRepo=<repoId>&leftBranch=<branch>` (git only)                              |
| Right side      | `rightRepo=…&rightBranch=…`                                                     |
| Current folder  | `path=sub/dir` (Folders)                                                        |
| Explained scope | `explain=/`, `explain=dir/` or `explain=dir/a.ts` (Folders); `explain=1` (File) |
| File            | `leftCommit`, `rightCommit`, `leftPath`, `rightPath` (File; sources as above)   |
| Focused hunk    | `hunk=<index>` (File; `full=1` for whole-file context)                          |
| Selected commit | `commit=<sha>` (Folders: details + footprint; Upstream: the commit in focus)    |
| Commit window   | `limit`, `since=YYYY-MM-DD`, `hide=1`, `fp=1`, `status=<filter>` (Upstream)     |

`lib/sources.ts` converts between the URL and `GitSource` objects (`sourceFromParams`, `sourcesSearch`); `lib/urls.ts` builds tab URLs (`foldersUrl`, `fileUrl`, `upstreamUrl`, `commitUrl`, `commitsUrl`).

### Tabs

`SessionWorkspace` (route `u/:user/s/:sessionId/*`) keeps the session's working contexts as tabs. Each tab is `{ id, url }` (`lib/workspace.ts`): the active tab's URL is the browser's, the others remember where the user left them. A tab is mounted on first visit and then stays mounted, rendered with `<Routes location={tab.url}>`, and inactive tabs are hidden with `visibility: hidden` and `inert` (not unmounted, not `display: none`), so expanded folders, filters, focus and scroll positions survive switching. The tab id is the comparison context: the two sources for Folder Compare and Upstream, the pinned commits and paths for File Compare, the repository and SHA for a Commit tab (`kind: commit`), the pinned File Compare plus a side for a Commit List (`kind: commits`), and the repository with its top and bottom revisions for a Range Log (`kind: log`) (`tabIdentity`, `IDENTITY` in `lib/workspace.ts`). `useWorkspace().open(url)` focuses the equivalent open tab as it was left, or opens a new one (`isExact` shows the given URL anyway; `isReplacing` puts the new context in the current tab's place). Tabs are kept per session in `sessionStorage` (`om-tabs:<user>:<session>`), so a reload restores them. The strip is shown only when more than the Overview is open. Upstream and Folders use the same `left*`/`right*` parameters, so the snapshots carry over between them.

The remembered username (`om-user`) and theme (`om-theme`) are in `localStorage`.

## Data fetching

The client is `lib/api.ts`. It turns error responses into `ApiRequestError(message)`, and an unreachable API (including the dev proxy's 502) into a "Can't reach the OM API server" error.

| Query key                                                                                     | Data                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `['sessions', user]`                                                                          | sessions list                                                                                                                                                          |
| `['session', user, sessionId]`                                                                | `SessionDetail`, shared by the header, overview and source pickers                                                                                                     |
| `['compare-trees', user, sessionId, left, right]`                                             | the folder tree from `POST /api/git/compare-trees` (`staleTime: Infinity`; **Rescan** refetches)                                                                       |
| `['snapshot-file-diff', user, sessionId, left, right, leftPath, rightPath, full, attributed]` | one file's git hunks (`lib/snapshot-diff.ts`); `attributed: false` is the plain diff File Compare shows first, `true` the explained one shared with folder attribution |
| `['upstream-commits', pair, window]`                                                          | the upstream commit window (`lib/upstream.ts`)                                                                                                                         |
| `['applicability', user, sessionId, upstream, downstream, sha]`                               | one commit's applicability                                                                                                                                             |
| `['commit-patch', user, sessionId, repoId, sha]`                                              | a commit's patch                                                                                                                                                       |

Git sources in analysis keys are pinned to the commits the comparison or window resolved (`branch` = SHA), so cached results never describe a moved branch.

### Attribution

`lib/attribution.ts` holds the pure rules (unit-tested): `diffTarget`/`differingFiles` (rename pairs count once), `summarizeAttribution` (commits per scope, per side, one-sided before shared history), `commitFootprint` (where a commit accounts for differences). `lib/pooled-queries.ts` runs many cached queries 4 at a time with progress and cancellation; folder attribution (`useDirectoryAttribution`) and upstream applicability use it. `useAnalyzedDiffs` reads every file diff analyzed so far for "where else does this commit account for differences".

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

### Upstream: the window, the patch and applicability are composed in the browser

The Upstream commit window (`lib/upstream-window.ts`) is composed from `POST /api/git/resolve` (the two snapshots, pinned), `POST /api/git/log` (upstream’s commits, with downstream’s excluded when they are hidden) and `POST /api/git/ancestry` (whether each shown commit is already in downstream). A commit’s patch is `POST /api/git/show`.

Applicability (`lib/applicability.ts`, `loadApplicability`) evaluates each commit on its own against the same pinned downstream commit, with the same rules the server used: `show` gives the commit and its first parent (a merge is evaluated against its first parent); `ancestry` says whether downstream already has it (then it is _represented_, by reachability); `merge-tree` merges the commit onto downstream with the upstream parent as base, and gives the conflicts (as excerpts of the merged text, `conflictExcerpts`) and the paths the merge changes; a clean merge that changes nothing is _represented_; and when a commit is represented or conflicts, `patch-equivalents` looks for downstream commits that make the same change (within 20 seconds, and reported as unfinished rather than as none). A conflict is never described as “missing”, and a clean apply is never described as “safe”.

The server no longer has `/api/upstream/*` or `/api/snapshot/file-diff`: the browser composes the same answers from the git primitives above.

### Colour and eye comfort

The palette is warm charcoal in dark and warm paper in light, with no pure black or white and softened status colours, so long reading sessions are gentle. `lib/palette.test.ts` reads `index.css` and enforces the rules:

- Text on every surface it is drawn over is at least **4.5:1** (WCAG AA).
- Status marks (`*-dot`) are at least **3:1** against the surface.
- Dark body text stays **below 13:1** to avoid glare.
- Every token exists in both themes, and neither uses `#000000` or `#ffffff`.

Meanings are fixed: green = only in Left (left), blue = only in Right (right), orange = different, red = error. Hairline dividers (`--color-line`) are decorative and exempt from the 3:1 rule.

### File Compare, Commit and Commit List

- **Layout.** File Compare opens **side by side**: Left (blue) on the left, Right (green) on the right, aligned row by row (`lib/diff-rows.ts`, `alignRows`). **Inline** is the single list with `+`/`−` lines. The choice is `view=inline` in the URL, so it survives a reload and a tab switch. The focused hunk and line persist across the switch.
- **Commit markers.** A changed line's commit marker opens that commit in its own **Commit tab** (`commit` kind). The commit's repository is the repository of the side whose history holds it (Left for removed lines, Right for added). The File Compare tab is not replaced.
- **Blame.** **Blame Left** and **Blame Right** (`blame=left`, `right` or `left,right` in the URL) mark every line of a side, context lines included, with the last change to that line in that side’s own history (`POST /api/git/blame` on that side’s commit). A commit the other side also has (`POST /api/git/ancestry`) is drawn dashed. The marker is labelled as the last change in that history, not as the cause, and it opens the commit as a commit marker does. A blamed side takes the place of the Explain commit column for that side.
- **Diverging commits.** "Left: diverging commits" and "Right: diverging commits" open a **Commit List** tab (`commits` kind, `side=left|right`). It is one list of the commits this side has and the other does not (`POST /api/git/log`: `source` is the side, `exclude` the other), grouped by day, with three filters: _all diverging_, _touching this file_ (`paths`), and _accounting for the changes shown_ (git blame attribution of this side's lines, or of the focused hunk). Search filters the loaded commits. **Select commits** and pick two to open the range between them in a Range Log.
- **Commit tab.** One commit as a reader wants it: its message (links clickable), author and dates, its SHA (copy), its parents (each opens its own Commit tab), and a **Log from here down to…** form that opens a Range Log. Its files are summarized (with line counts; a filter; tapping one jumps to it) and each file is a collapsible diff, collapsed when there are more than 10. The data comes from `POST /api/git/show` and `POST /api/git/log`.
- **Range Log** (`log` kind, `repo=&top=&bottom=`): the commits `top` has and `bottom` does not, newest first, with `bottom` as the end of the range. It pages 50 at a time, shows each commit's message and changed files with line counts, and expands a commit to its diff on request. A banner says so when `bottom` is not in `top`'s history (`excludeIsAncestor` from the log). It is opened from a Commit List (select two), a Commit tab, or the overview's **Commit log** form.
- **Back and forth.** Each new tab is opened in the background; "File compare" in a Commit List returns to the File Compare tab as it was left.

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
- **Upstream** shows the compared sources as a read-only summary; a new comparison starts in the overview, as on Folder Compare.
- **Landscape (`short`):** the header and the session's tab strip share one row (the strip moves into the header's middle slot, `components/header-slot.tsx`). The Upstream window settings fold into a one-line "Window: last N commits" toggle. The Folder Compare sources line and breadcrumb are tighter. The Folder Compare toolbar uses `Toolbar`, so its secondary actions move into More.
- **Touch (`coarse`):** one tap on a file opens it and one tap on a folder expands it. Row actions stay visible without hover. A commit marker opens a small details popover (subject, author, date) with an **Open commit** button. The diff has **Next change** and **Previous change** buttons, standing in for `j`/`k`. Labels that may be cut short (the File Compare path, the diff column labels) are `FullText`: with a mouse the full text is in the tooltip, and on touch tapping shows it in a popover.
- **Diffs on a phone:** File Compare opens **inline** below 640px unless the URL says `view=side`, and keeps the choice in the URL either way. **Wrap lines** (`wrap=0` in the URL) makes long lines scroll sideways in their pane instead of wrapping. The gutters are narrower below 640px, and hunk headers stick under the column header.
