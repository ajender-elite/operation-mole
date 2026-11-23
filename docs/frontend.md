# Frontend

Code: `apps/web/src`. Built with React 19, Vite 8, Tailwind CSS v4, TanStack Query 5, React Router and Monaco.

## Routes

| Path                             | Page                   | Purpose                                                                                                 |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `/`                              | `WelcomePage`          | Enter a username (skipped if one is remembered)                                                         |
| `/u/:user`                       | `SessionsPage`         | List, create and delete sessions; switch user                                                           |
| `/u/:user/s/:sessionId`          | `SessionOverviewPage`  | Add a repo (all it shows when there is none); then compare, recent comparisons, repos with Fetch latest |
| `/u/:user/s/:sessionId/folders`  | `DirectoryComparePage` | Folder Compare: what differs, as a tree; "Explain difference" on request                                |
| `/u/:user/s/:sessionId/file`     | `FileComparePage`      | File Compare: one file at the commits its Folder Compare resolved; "Explain difference" on request      |
| `/u/:user/s/:sessionId/files`    | redirect to `folders`  | Files was folded into Folders (query kept)                                                              |
| `/u/:user/s/:sessionId/upstream` | `UpstreamPage`         | Upstream commit window and applicability to downstream                                                  |
| `/u/:user/s/:sessionId/lab`      | redirect to `upstream` | The placeholder Upstream replaced (query kept)                                                          |
| `/directories`, `/files`         | redirect to `/`        | Links from before sessions                                                                              |

`AppShell` is the layout around every page. It shows the OM logo, the `user › session` breadcrumb, the session navigation (inside a session only) and the theme toggle. It gets the user and session from `useMatch`.

## The URL is the state

Everything needed to rebuild a view is in the URL, so reloads, bookmarks and Back/Forward work:

| What            | Where                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| User, session   | path (`/u/:user/s/:sessionId`)                                                  |
| Base side       | `leftRepo=<repoId>&leftBranch=<branch>` (git only)                              |
| Target side     | `rightRepo=…&rightBranch=…`                                                     |
| Current folder  | `path=sub/dir` (Folders)                                                        |
| Explained scope | `explain=/`, `explain=dir/` or `explain=dir/a.ts` (Folders); `explain=1` (File) |
| File            | `leftCommit`, `rightCommit`, `leftPath`, `rightPath` (File; sources as above)   |
| Focused hunk    | `hunk=<index>` (File; `full=1` for whole-file context)                          |
| Selected commit | `commit=<sha>` (Folders: details + footprint; Upstream: the commit in focus)    |
| Commit window   | `limit`, `since=YYYY-MM-DD`, `hide=1`, `fp=1`, `status=<filter>` (Upstream)     |

`lib/sources.ts` converts between the URL and `GitSource` objects (`sourceFromParams`, `sourcesSearch`); `lib/urls.ts` builds tab URLs (`foldersUrl`, `fileUrl`, `upstreamUrl`).

### Tabs

`SessionWorkspace` (route `u/:user/s/:sessionId/*`) keeps the session's working contexts as tabs. Each tab is `{ id, url }` (`lib/workspace.ts`): the active tab's URL is the browser's, the others remember where the user left them. A tab is mounted on first visit and then stays mounted, rendered with `<Routes location={tab.url}>`, and inactive tabs are hidden with `visibility: hidden` and `inert` (not unmounted, not `display: none`), so expanded folders, filters, focus and scroll positions survive switching. The tab id is the comparison context: the two sources for Folder Compare and Upstream, the pinned commits and paths for File Compare (`tabIdentity`). `useWorkspace().open(url)` focuses the equivalent open tab as it was left, or opens a new one (`isExact` shows the given URL anyway; `isReplacing` puts the new context in the current tab's place). Tabs are kept per session in `sessionStorage` (`om-tabs:<user>:<session>`), so a reload restores them. The strip is shown only when more than the Overview is open. Upstream and Folders use the same `left*`/`right*` parameters, so the snapshots carry over between them.

The remembered username (`om-user`) and theme (`om-theme`) are in `localStorage`.

## Data fetching

The client is `lib/api.ts`. It turns error responses into `ApiRequestError(message)`, and an unreachable API (including the dev proxy's 502) into a "Can't reach the OM API server" error.

| Query key                                                                                     | Data                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `['sessions', user]`                                                                          | sessions list                                                                                                                                                          |
| `['session', user, sessionId]`                                                                | `SessionDetail`, shared by the header, overview and source pickers                                                                                                     |
| `['compare-directories', user, sessionId, left, right]`                                       | comparison result (`staleTime: Infinity`; **Rescan** refetches)                                                                                                        |
| `['compare-files', left, right]`                                                              | file diff                                                                                                                                                              |
| `['defaults']`                                                                                | default example folders                                                                                                                                                |
| `['snapshot-file-diff', user, sessionId, left, right, leftPath, rightPath, full, attributed]` | one file's git hunks (`lib/snapshot-diff.ts`); `attributed: false` is the plain diff File Compare shows first, `true` the explained one shared with folder attribution |
| `['upstream-commits', pair, window]`                                                          | the upstream commit window (`lib/upstream.ts`)                                                                                                                         |
| `['applicability', user, sessionId, upstream, downstream, sha]`                               | one commit's applicability                                                                                                                                             |
| `['commit-patch', user, sessionId, repoId, sha]`                                              | a commit's patch                                                                                                                                                       |

Git sources in analysis keys are pinned to the commits the comparison or window resolved (`branch` = SHA), so cached results never describe a moved branch.

### Attribution

`lib/attribution.ts` holds the pure rules (unit-tested): `diffTarget`/`differingFiles` (rename pairs count once), `summarizeAttribution` (commits per scope, per side, one-sided before shared history), `commitFootprint` (where a commit accounts for differences). `lib/pooled-queries.ts` runs many cached queries 4 at a time with progress and cancellation; folder attribution (`useDirectoryAttribution`) and upstream applicability use it. `useAnalyzedDiffs` reads every file diff analyzed so far for "where else does this commit account for differences".

`lib/session.ts`'s `useRepoActions` provides the clone and fetch mutations. They put the returned `RepoInfo` straight into the cached session, then refetch it. Running a comparison also refetches the session, so its recent list stays current.

## Main components

| Component          | Notes                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CompareForm`      | Two `SourcePicker`s, a swap button and Compare. It's remounted (via `key`) whenever the URL's sources change.                                                                                                                        |
| `SourcePicker`     | Folder / Git repo toggle; folder path; repo select with **Add a repository…** (URL + Clone); branch select; **Fetch latest**. Its draft type and helpers are in `lib/source-draft.ts`.                                               |
| `CompareTree`      | Rows for Base and Target from one flat list (`lib/tree.ts` `flattenTree`), so both sides stay aligned. Treeitem roles, keyboard support (Enter, arrow keys), hover actions.                                                          |
| `SnapshotDiffView` | Git's hunks for one file, Base → Target, with line numbers on both sides, an attribution chip per changed line (dashed when the commit is in both histories), hunk/line focus (`n`/`p`, `j`/`k`), and dimming for a selected commit. |
| `AttributionPanel` | "What accounts for this difference" for what the user asked to explain (repository, folder, file, hunk, line), progress for folders, commit details with its footprint, and a close button.                                          |
| `DiffView`         | Monaco `DiffEditor`, lazy-loaded, with Monaco and its worker bundled locally. Read-only. `useInlineViewWhenSpaceIsLimited: false` so the side-by-side button always works.                                                           |
| `ThemeToggle`      | Switches light and dark (`lib/theme.ts`, a `useSyncExternalStore` store). It sets `html[data-theme]`; without a choice, the system setting decides.                                                                                  |
| `Logo`             | The OM mole (`public/favicon.svg`), also used as the browser-tab icon.                                                                                                                                                               |

## Styling

Tailwind v4 with design tokens in `src/index.css` (`@theme`):

- **Colors:** `--color-left*` (green), `--color-right*` (blue), `--color-modified*` (orange), `--color-error*` (red), plus surface, line, muted and accent tokens.
- **Dark mode:** tokens are redefined under `:root[data-theme='dark']`, and under `prefers-color-scheme: dark` unless light was chosen.
- **`dark:` variant:** a custom variant that covers both of those cases.
