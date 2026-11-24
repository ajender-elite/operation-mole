# Comparison rules

Code: `apps/server/src/compare/` (`git-trees.ts` for the folder tree, `summary.ts` for the counts, `sort.ts` for the order). Each rule is covered by `test/tree-compare-rules.test.ts` (leaf maps, no disk), `test/git-directory-compare.test.ts` (real git trees), `test/sort.test.ts`, and on a real repository by `test/nginx-branches.test.ts`.

The rules apply to the trees of two git sides. Nothing is compared on disk: a file is identical when its object id is, which is the byte content.

## Matching

Entries are matched by **relative path**: `src/a.ts` on the left side is compared with `src/a.ts` on the right side. Files with different names are never paired as one entry, except git renames (below).

### Renames (git sides only)

OM asks git which files were renamed between the two commits (`git diff -M --diff-filter=R`). The tree still lists the old name as only-in-left and the new name as only-in-right, but links them: `renamedTo`/`renamedFrom` plus git's similarity percentage. The UI shows "renamed → new/path (92%)" and diffs the pair as one file. Summary counts are unchanged.

## Statuses

| Status       | Files and symlinks                                                        | Folders                                                   | UI                                    |
| ------------ | ------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| `identical`  | Same bytes (symlinks: same target)                                        | Present on both sides and **everything inside** identical | default color                         |
| `modified`   | Different bytes or size (symlinks: different target; a symlink vs a file) | Present on both sides with a difference somewhere inside  | orange row; folders get an orange dot |
| `only-left`  | Only in left                                                              | Only in left (and so is everything inside)                | green                                 |
| `only-right` | Only in right                                                             | Only in right                                             | blue                                  |
| `error`      | Couldn't be read (e.g. permissions)                                       | Couldn't be listed                                        | red, with the error message           |

Details:

- **Byte comparison:** sizes are compared first, so different sizes mean different without reading. Otherwise both files are read in 64 KB chunks until the first difference.
- **A file and a folder with the same name** can't be compared, so they're listed as **two one-sided entries**: the file sorts with the files, the folder with the folders. Opening that path means the folder.
- **Symlinks are not followed.** They're compared by target, and a symlink to a folder has no children.
- **Empty folders** compare as identical when present on both sides.
- **Git sources** skip `.git` at their root.
- **An error inside a folder** makes that folder `modified`.

## Sort order

Every level lists **all folders first, then all files** (including symlinks). Within each group, names use `compareNames`:

```ts
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
compareNames = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
```

| Rule                                         | Example                                        |
| -------------------------------------------- | ---------------------------------------------- |
| Numbers by value                             | `2` < `10` < `100`; `file2.txt` < `file10.txt` |
| Case ignored                                 | `a.txt`, `B.txt`, `c.txt`                      |
| Accents sort next to the plain letter        | `report.txt`, `résumé.txt`                     |
| Symbols, then digits, then letters           | `_private`, `.config`, `2024-archive`, `Alpha` |
| Equal values: code-point tie-break           | `007` before `7`; `A.txt` before `a.txt`       |
| After a shared prefix, digits before letters | `1.5.txt` before `1.txt`                       |

Only the server sorts; the UI keeps the order it receives. The locale is fixed to English, so every machine gives the same order.

## Summary counts

The summary counts **files and symlinks** by status, including those inside one-sided folders. Folders aren't counted, since they only collect their contents' statuses. A file/folder name clash counts the file as one-sided. Unreadable entries count as errors.

## File diff (git sides)

For two git snapshots, opening a file shows **git's own hunks** for that file between the two commits (`git diff` of the two blobs), read Left → Right. Attribution is asked for separately (see the investigation model). A rename pair is diffed as one file; a one-sided file is one hunk of only `−` or only `+` lines. Binary files (same NUL rule) and text over 5 MB get no hunks. See [investigation model](investigation-model.md).
