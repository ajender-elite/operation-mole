# Frontend

Code: `apps/web/src`. Built with React 19, Vite 8, Tailwind CSS v4, TanStack Query 5, React Router and Monaco.

## Routes

| Path                             | Page                   | Purpose                                                                                                              |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/`                              | `WelcomePage`          | Enter a username (skipped if one is remembered)                                                                      |
| `/u/:user`                       | `SessionsPage`         | List, create and delete sessions; switch user                                                                        |
| `/u/:user/s/:sessionId`          | `SessionOverviewPage`  | Recent comparisons; repos with Fetch latest; add a repo                                                              |
| `/u/:user/s/:sessionId/folders`  | `DirectoryComparePage` | Pick Base and Target, compare, browse the tree; for git snapshots also open files in place and attribute differences |
| `/u/:user/s/:sessionId/files`    | `FileComparePage`      | Monaco diff of two files                                                                                             |
| `/u/:user/s/:sessionId/upstream` | `UpstreamPage`         | Upstream commit window and applicability to downstream                                                               |
| `/u/:user/s/:sessionId/lab`      | redirect to `upstream` | The placeholder Upstream replaced (query kept)                                                                       |
| `/directories`, `/files`         | redirect to `/`        | Links from before sessions                                                                                           |

`AppShell` is the layout around every page. It shows the OM logo, the `user › session` breadcrumb, the session navigation (inside a session only) and the theme toggle. It gets the user and session from `useMatch`.

## The URL is the state

Everything needed to rebuild a view is in the URL, so reloads, bookmarks and Back/Forward work:

| What            | Where                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| User, session   | path (`/u/:user/s/:sessionId`)                                               |
| Base side       | `left=/abs/path` **or** `leftRepo=<repoId>&leftBranch=<branch>`              |
| Target side     | `right=…` **or** `rightRepo=…&rightBranch=…`                                 |
| Current folder  | `path=sub/dir` (Folders)                                                     |
| Open file       | `file=sub/dir/a.ts` (Folders, git snapshots: diff in place)                  |
| Focused hunk    | `hunk=<index>` (Folders; `full=1` for whole-file context)                    |
| Selected commit | `commit=<sha>` (Folders: details + footprint; Upstream: the commit in focus) |
| Commit window   | `limit`, `since=YYYY-MM-DD`, `hide=1`, `fp=1`, `status=<filter>` (Upstream)  |
| Files to diff   | `left=/abs/file&right=/abs/file` (Files)                                     |
| Way back        | `from=/u/…/folders?…` (Files; only `/u/…` values are accepted)               |

`lib/sources.ts` converts between the URL and `Source` objects (`sourceFromParams`, `sourcesSearch`). Expanded folders, filters, the focused tree row and the focused line are kept in component state; opening a file in place keeps the tree mounted (hidden), so they and its scroll position survive going back. Upstream and Folders use the same `left*`/`right*` parameters, so the snapshots carry over between them.

The remembered username (`om-user`) and theme (`om-theme`) are in `localStorage`.

## Data fetching

The client is `lib/api.ts`. It turns error responses into `ApiRequestError(message)`, and an unreachable API (including the dev proxy's 502) into a "Can't reach the OM API server" error.

| Query key                                                                         | Data                                                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `['sessions', user]`                                                              | sessions list                                                                                                  |
| `['session', user, sessionId]`                                                    | `SessionDetail`, shared by the header, overview and source pickers                                             |
| `['compare-directories', user, sessionId, left, right]`                           | comparison result (`staleTime: Infinity`; **Rescan** refetches)                                                |
| `['compare-files', left, right]`                                                  | file diff                                                                                                      |
| `['defaults']`                                                                    | default example folders                                                                                        |
| `['snapshot-file-diff', user, sessionId, left, right, leftPath, rightPath, full]` | one file's git hunks with attribution (`lib/snapshot-diff.ts`), shared by the file view and folder attribution |
| `['upstream-commits', pair, window]`                                              | the upstream commit window (`lib/upstream.ts`)                                                                 |
| `['applicability', user, sessionId, upstream, downstream, sha]`                   | one commit's applicability                                                                                     |
| `['commit-patch', user, sessionId, repoId, sha]`                                  | a commit's patch                                                                                               |

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
| `AttributionPanel` | "What accounts for this difference" for the current focus (repository, folder, file, hunk, line), progress for folders, and commit details with its footprint.                                                                       |
| `DiffView`         | Monaco `DiffEditor`, lazy-loaded, with Monaco and its worker bundled locally. Read-only. `useInlineViewWhenSpaceIsLimited: false` so the side-by-side button always works.                                                           |
| `ThemeToggle`      | Switches light and dark (`lib/theme.ts`, a `useSyncExternalStore` store). It sets `html[data-theme]`; without a choice, the system setting decides.                                                                                  |
| `Logo`             | The OM mole (`public/favicon.svg`), also used as the browser-tab icon.                                                                                                                                                               |

## Styling

Tailwind v4 with design tokens in `src/index.css` (`@theme`):

- **Colors:** `--color-left*` (green), `--color-right*` (blue), `--color-modified*` (orange), `--color-error*` (red), plus surface, line, muted and accent tokens.
- **Dark mode:** tokens are redefined under `:root[data-theme='dark']`, and under `prefers-color-scheme: dark` unless light was chosen.
- **`dark:` variant:** a custom variant that covers both of those cases.
