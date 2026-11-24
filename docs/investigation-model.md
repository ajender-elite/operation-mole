# Investigation model

How OM answers "what is different, what accounts for it, which commits are on one side only, and does a series apply?", and the
precise git meaning of each answer. Code: `apps/server/src/git-api/` (the primitives, including `cherry-pick`),
`apps/server/src/snapshot/` (file diffs), `apps/web/src/lib/attribution.ts` (the composition),
`apps/web/src/pages/directory-compare-page.tsx`, `apps/web/src/pages/between-page.tsx`, `apps/web/src/pages/series-page.tsx`
and `apps/web/src/components/series-verdict.tsx`.

## Terms

| Term                  | In OM                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Snapshot**          | A git side resolved to an exact commit (`SnapshotInfo`). A branch, tag or SHA can name it; the commit is its identity. Folders shows each side's commit next to its label.                                                                                                 |
| **Left / Right**      | The two snapshots of a comparison (`left` / `right` in code and URLs). Comparison is neutral: neither side is upstream, newer or correct.                                                                                                                                  |
| **Snapshot diff**     | Directional: hunks read Left → Right. `−` lines exist only in Left, `+` lines only in Right. Swapping sides swaps the signs.                                                                                                                                               |
| **Divergence commit** | A commit that `git blame` currently attributes at least one differing line to, **on that line's own side**: `−` lines are blamed in Left's history, `+` lines in Right's. It is not necessarily where the content was first written or where the histories first diverged. |
| **Between**           | The commits on each side of two branches (`left...right`), each marked **only on the left**, **only on the right**, or **picked across** (the same change on the other side, by patch id). Left and Right are roles of the comparison only.                                |
| **Series**            | Commits to pick, in order, checked on a branch as `git cherry-pick` would apply them, each on the result of the one before. A dry run: nothing is written to a ref, an index or a worktree.                                                                                |

## Attribution on request, scoped to the focus

Folder Compare and File Compare first show only what differs. Attribution is computed when the user asks (**Explain difference**), for exactly what they asked about, and then narrows with focus inside a file. The server answers each question with a git primitive (`POST /api/git/blame`, `POST /api/git/ancestry`); the browser combines the answers:

| Focus                              | Scope                                               | Source                                                                   |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| "Explain differences here"         | Repository or Folder: every differing file under it | one file diff per differing file, 4 at a time, aggregated in the browser |
| "Explain difference" on a folder   | that folder                                         | same                                                                     |
| "Explain difference" on a file     | File                                                | `POST /api/git/blame` for each side and `POST /api/git/ancestry`         |
| a hunk (click its header, `n`/`p`) | Hunk                                                | the hunk's lines                                                         |
| a line (click it, `j`/`k`)         | Line                                                | that line's commit                                                       |
| a commit (`commit=` in the URL)    | Commit details and its footprint                    | every file diff analyzed so far in this comparison                       |

Rules the panel keeps:

- **Narrow scope, narrow data.** A folder's commits come only from files under it; nothing repository-wide leaks into a narrower focus.
- **A hunk keeps every commit.** Counts are per commit and per side; a hunk is never forced into one commit.
- **Shared history is labelled.** A commit reachable from both snapshots (`inLeft` and `inRight`) accounts for content both once had; the difference comes from the other side changing or removing it. Such commits are grouped after the one-sided ones under "Shared history".
- **Unattributed lines are counted.** Binary or oversized files, and lines where blame failed, show as "N of M changed lines have no attribution".
- **Nothing is attributed unasked.** Opening a comparison or a file runs no `git blame`: File Compare requests the plain diff (`attribute: false`); the explained diff is fetched only after "Explain difference". Blame of a side is also on request (the **Blame Left/Right** toggle), and is labelled as the last change in that side's history, not as the cause.
- **Large folders still confirm.** Asked to explain more than 40 differing files, the panel says how many and starts on a click. The tree is navigable immediately either way.
- **Commit → differences.** Selecting a commit lists the files and hunks it accounts for among analyzed files, highlights them (and their folders) in the tree, and dims other lines in the diff. "Search every difference under …" analyzes the current folder to find the rest.

## Series steps

A series `C1 … Cn` is checked on a branch `B` (any remote of the repo) by `POST /api/git/cherry-pick`. The server first checks the request as a whole: a commit that is missing, is not a commit, is listed twice, is a merge (it needs a mainline parent, which OM does not choose), or is a root commit refuses the whole series, and no step runs. Then each commit is applied in order, each on the result of the one before, with its own parent as the base (`git merge-tree --write-tree --merge-base=<parent>`), as `git cherry-pick` does.

| Step status  | Meaning (and only this)                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `in-history` | The commit is already in `B`'s history (`git merge-base --is-ancestor`). Skipped; the run goes on.                                                                                                        |
| `no-change`  | The commit applies, but the result is unchanged: its change is already there. The run goes on.                                                                                                            |
| `applies`    | No conflicts, and the result differs from the previous step. Technical applicability only, not semantic safety.                                                                                           |
| `conflict`   | Git cannot merge it. The run stops here, and later steps are `not-run`. Never read as "missing": the branch may hold an evolved or partial form. The conflicted paths and their merged text are returned. |
| `not-run`    | After a conflict, so not applied.                                                                                                                                                                         |

The outcome is `applies` (every step applied or skipped), `conflict` (with `stoppedAt`), or `invalid` (refused before any step). A single commit checked on each branch is a series of one.

Evidence for every result: each step's files, the conflicted paths with their merged text (markers included, up to ten files), git's own messages, and the paths the picks change on the branch up to the stop.

Git has no "merged date"; OM shows author and commit dates as git records them and never derives one.

## Between marks

`git log --left-right --cherry-mark` over `left...right` gives each commit a side, and marks a commit `equivalent` when another commit on the other side has the same patch id. A pair matched that way is "picked across": the change is on both branches, possibly under different commit ids. Merge commits are left out.

## Picked as, in the Branches pane

A commit's Branches pane checks it on each branch as a one-pick series (`cherry-pick`). That check says whether the commit is already in the branch's history, or would apply, or would conflict. A separate lookup asks whether the branch already has the same change under another commit id: `patch-equivalents` of the commit alone (bounded by its first parent, so only its own change is compared) against the branch's newest 200 commits. A match is shown as **Picked as \<sha\>**, with the words "the same change is already on this branch, as another commit". It is found by patch id, so a change that was re-applied with edits is not found by that search.

A second search covers the other way a pick is recorded: `git cherry-pick -x` writes `(cherry picked from commit <sha>)` into the message. Commits on the branch that mention the checked commit's full SHA (newest 20) are read, and one whose message says it picked this commit is shown as **Picked as \<sha\> (noted in its message)**. That is what the branch says, not a check of its content: an edited re-apply without the trailer is still not found. A message that only mentions the commit in another way (for example a revert) does not count.

A root commit has no parent to bound the patch search, so it has no lookup at all.

## Semantic boundaries

These stay distinct everywhere in the UI and API:

- Snapshot comparison ≠ between marks ≠ series checks (three different questions, each with its own page).
- Current attribution ≠ historical root cause; git blame ≠ a complete historical explanation.
- Already represented ≠ same SHA; commit identity ≠ patch equivalence ≠ content equivalence (three different reasons).
- Conflicting step ≠ change missing; clean step ≠ safe integration.
- A series is checked as a sequence: each step sees the result of the one before, so a later pick can depend on an earlier one.

## Safety

Series checks and Between run git with `GIT_OBJECT_DIRECTORY` pointed at a fresh scratch folder (`<data>/scratch/objects-*`) and the clones' object folders as alternates. No index, worktree or ref is written, and the scratch folder is removed on success, conflict, failure and cancellation (client disconnect aborts git). Tests check refs, `git status`, object counts and the scratch folder before and after.

## Where the implementation stood, and what changed

The audit before this work, against the product contract:

| Capability                      | Before                                                                        | Now                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Snapshot model                  | PARTIAL: git sides were "repo @ branch"; branch tips only; no commit identity | Resolved commit per side; branch, tag or SHA                                                          |
| Folder compare                  | COMPLETE for statuses, sort, URL state                                        | Kept as is                                                                                            |
| Renames                         | MISSING (decision 2 declined it)                                              | Git rename detection links one-sided entries for git sides                                            |
| Text compare                    | PARTIAL: path-based diff with its own diff engine, no hunk model              | Git's hunks for git snapshots in a File Compare tab, with direction, focus and on-request attribution |
| Attribution (folder → line)     | MISSING                                                                       | Directional blame at every scope, commit → differences                                                |
| Commits between, series checks  | MISSING (Lab placeholder, then the Upstream page)                             | Between (marks) and Series (`cherry-pick` dry run, one commit or many, per branch of every remote)    |
| Cross-remote analysis           | ARCHITECTURALLY LIMITING: one clone per remote, no shared object view         | Object views via alternates in the environment (no clone is modified)                                 |
| Abort signals on git operations | MISSING (open item in CONTRIBUTING)                                           | Analysis commands take an `AbortSignal`; clone/fetch/checkout still don't                             |
| Real-git test fixtures          | PARTIAL: tiny origin repo, no pinned seed, machine git identity mixed in      | Pinned Hello-World seed bundle, deterministic scenarios, real partial clones, remote smoke test       |

## Known limits

- **Deleted content.** When one side no longer has a file, its lines can only be blamed on the side that has them; the commit that removed the file on the other side isn't identified.
- **Blame follows renames inside one history**, but prefetching (below) covers only the current path; older paths are fetched lazily.
- **Blob-less clones.** Blame needs a file's history. OM fetches it in one request (`GitService.prefetchMissing`) instead of git's one-object-at-a-time lazy fetch. The first attribution of a file still costs a network round trip.
- **Directory attribution is per file.** A folder with thousands of differing files is analyzed only on request; results are cached by commit SHA, on the server and in the browser.
- **The tree is not virtualized**; only expanded folders render rows. Very large flat folders render every row.
- **A machine-wide `blame.ignoreRevsFile`** pointing at a file that doesn't exist makes git blame fail; OM shows git's message instead of attribution.
- **Series steps are per branch.** A series is checked against the branch as it is; a merge commit in the series is refused until a mainline parent can be chosen.
