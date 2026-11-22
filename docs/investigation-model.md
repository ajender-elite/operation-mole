# Investigation model

How OM answers "what is different, what accounts for it, and does upstream apply?", and the
precise git meaning of each answer. Code: `apps/server/src/snapshot/`, `apps/server/src/upstream/`,
`apps/web/src/lib/attribution.ts`, `apps/web/src/pages/directory-compare-page.tsx` and
`apps/web/src/pages/upstream-page.tsx`.

## Terms

| Term                      | In OM                                                                                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Snapshot**              | A git side resolved to an exact commit (`SnapshotInfo`). A branch, tag or SHA can name it; the commit is its identity. Folders shows each side's commit next to its label.                                                                                                  |
| **Base / Target**         | The two snapshots of a comparison (`left` / `right` in code and URLs). Comparison is neutral: neither side is upstream, newer or correct.                                                                                                                                   |
| **Snapshot diff**         | Directional: hunks read Base → Target. `−` lines exist only in Base, `+` lines only in Target. Swapping sides swaps the signs.                                                                                                                                              |
| **Divergence commit**     | A commit that `git blame` currently attributes at least one differing line to, **on that line's own side**: `−` lines are blamed in Base's history, `+` lines in Target's. It is not necessarily where the content was first written or where the histories first diverged. |
| **Upstream / downstream** | Roles introduced only by the Upstream page: upstream = Base (`left*` in the URL), downstream = Target (`right*`). The same URLs carry snapshots between Folders and Upstream.                                                                                               |
| **Applicability**         | What applying one upstream commit (its change against its first parent) to the pristine downstream snapshot does, computed with `git merge-tree`.                                                                                                                           |

## Attribution follows focus

The attribution panel in Folders (git snapshots on both sides) explains the narrowest thing in focus:

| Focus                              | Scope                                               | Source                                                                   |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| current folder (nothing focused)   | Repository or Folder: every differing file under it | one file diff per differing file, 4 at a time, aggregated in the browser |
| a folder row                       | that folder                                         | same                                                                     |
| a file row, or an open file        | File                                                | one `POST /api/snapshot/file-diff`                                       |
| a hunk (click its header, `n`/`p`) | Hunk                                                | the hunk's lines                                                         |
| a line (click it, `j`/`k`)         | Line                                                | that line's commit                                                       |
| a commit (`commit=` in the URL)    | Commit details and its footprint                    | every file diff analyzed so far in this comparison                       |

Rules the panel keeps:

- **Narrow scope, narrow data.** A folder's commits come only from files under it; nothing repository-wide leaks into a narrower focus.
- **A hunk keeps every commit.** Counts are per commit and per side; a hunk is never forced into one commit.
- **Shared history is labelled.** A commit reachable from both snapshots (`inLeft` and `inRight`) accounts for content both once had; the difference comes from the other side changing or removing it. Such commits are grouped after the one-sided ones under "Shared history".
- **Unattributed lines are counted.** Binary or oversized files, and lines where blame failed, show as "N of M changed lines have no attribution".
- **Large folders wait.** More than 40 differing files: attribution starts on a click. The tree is navigable immediately either way.
- **Commit → differences.** Selecting a commit lists the files and hunks it accounts for among analyzed files, highlights them (and their folders) in the tree, and dims other lines in the diff. "Search every difference under …" analyzes the current folder to find the rest.

## Applicability states

Each upstream commit `U` is evaluated **independently** against the **same** downstream commit `D`: `git merge-tree --write-tree --merge-base=U^1 D U` (the empty tree for a root commit). It never builds on another evaluation's result; that would be series integration, a different question.

| Status        | Reason                | Meaning (and only this)                                                                                                                                           |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `represented` | `reachable`           | `git merge-base --is-ancestor U D`: downstream contains this exact commit.                                                                                        |
| `represented` | `equivalent-patch`    | Applying `U` leaves `D`'s tree unchanged, and `git log --cherry-mark` finds a downstream commit with the same patch-id (listed).                                  |
| `represented` | `no-effective-change` | Applying `U` leaves `D`'s tree unchanged, and no patch-equivalent commit was found (squashed, combined with other changes, or independent).                       |
| `clean`       | `applies`             | No conflicts, and the result differs from `D`. Technical applicability only, not semantic safety. Files that already match are listed as "partially represented". |
| `conflict`    | `conflict`            | Git can't apply it automatically. Never read as "missing": downstream may hold an evolved or partial form. If a patch-equivalent commit exists, OM says so.       |
| `unknown`     | `error`               | Git failed; `detail` says why. OM does not guess.                                                                                                                 |

Evidence for every result: the files the commit touches with a per-file outcome (`applies`, `already matches`, `conflict`), conflict excerpts from git's merge result (markers included), patch-equivalent commits, git's own messages, the commit's patch, and links that open Folders on the upstream commit's tree against downstream with that file open (snapshot compare plus attribution).

Merge commits are evaluated against their first parent, like `git cherry-pick -m 1`, and say so. Git has no "merged date"; OM shows author and commit dates as git records them and never derives one.

## Semantic boundaries

These stay distinct everywhere in the UI and API:

- Snapshot comparison ≠ commit applicability (applicability is a separate page with explicit roles).
- Current attribution ≠ historical root cause; git blame ≠ a complete historical explanation.
- Already represented ≠ same SHA; commit identity ≠ patch equivalence ≠ content equivalence (three different reasons).
- Conflicting apply ≠ change missing; clean apply ≠ safe integration.
- Independent applicability ≠ sequential series integration.

## Safety

Applicability runs `merge-tree` with `GIT_OBJECT_DIRECTORY` pointed at a fresh scratch folder (`<data>/scratch/objects-*`) and the clones' object folders as alternates. No index, worktree, ref or merge/cherry-pick state is involved, and the scratch folder is removed on success, conflict, failure and cancellation (client disconnect aborts git). Tests check refs, HEAD, `git status`, object counts and every file in the git folder before and after, on OM's clones and on a developer-style working repository.

## Where the implementation stood, and what changed

The audit before this work, against the product contract:

| Capability                       | Before                                                                        | Now                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Snapshot model                   | PARTIAL: git sides were "repo @ branch"; branch tips only; no commit identity | Resolved commit per side; branch, tag or SHA                                                                   |
| Folder compare                   | COMPLETE for statuses, sort, URL state                                        | Kept as is                                                                                                     |
| Renames                          | MISSING (decision 2 declined it)                                              | Git rename detection links one-sided entries for git sides                                                     |
| Text compare                     | PARTIAL: path-based Monaco diff with its own diff engine, no hunk model       | Git's hunks for git snapshots, in place, with direction, focus and attribution; Monaco kept ("Open in editor") |
| Attribution (folder → line)      | MISSING                                                                       | Directional blame at every scope, commit → differences                                                         |
| Upstream history / applicability | MISSING (Lab placeholder)                                                     | Upstream page                                                                                                  |
| Cross-remote analysis            | ARCHITECTURALLY LIMITING: one clone per remote, no shared object view         | Object views via alternates in the environment (no clone is modified)                                          |
| Abort signals on git operations  | MISSING (open item in CONTRIBUTING)                                           | Analysis commands take an `AbortSignal`; clone/fetch/checkout still don't                                      |
| Real-git test fixtures           | PARTIAL: tiny origin repo, no pinned seed, machine git identity mixed in      | Pinned Hello-World seed bundle, deterministic scenarios, real partial clones, remote smoke test                |

## Known limits

- **Deleted content.** When one side no longer has a file, its lines can only be blamed on the side that has them; the commit that removed the file on the other side isn't identified.
- **Blame follows renames inside one history**, but prefetching (below) covers only the current path; older paths are fetched lazily.
- **Blob-less clones.** Blame needs a file's history. OM fetches it in one request (`GitService.prefetchMissing`) instead of git's one-object-at-a-time lazy fetch. The first attribution of a file still costs a network round trip.
- **Directory attribution is per file.** A folder with thousands of differing files is analyzed only on request; results are cached by commit SHA, on the server and in the browser.
- **The tree is not virtualized**; only expanded folders render rows. Very large flat folders render every row.
- **A machine-wide `blame.ignoreRevsFile`** pointing at a file that doesn't exist makes git blame fail; OM shows git's message instead of attribution.
