# Data model

All state lives under the data folder: `OM_DATA_DIR`, by default `.data/` in the project, which is excluded from git. To reset everything, stop the server and delete the folder.

## SQLite (`.data/om.db`)

The database is opened with Node's built-in `node:sqlite` (`DatabaseSync`) in `apps/server/src/store/store.ts`. The schema is created with `CREATE TABLE IF NOT EXISTS` at startup, and foreign keys are on, so deleting a row also deletes the rows that depend on it.

Columns are snake_case. Queries alias them to the API's camelCase names (`created_at AS createdAt`), and every row is parsed with a zod schema rather than cast, so a mismatch between a query and its type fails loudly. JSON columns (`branches`, `left_src`, `right_src`) are parsed and validated the same way.

```
users (username PK, created_at)
  └─< sessions (id PK, username FK, name, created_at, updated_at, UNIQUE(username, name COLLATE NOCASE))
        ├─< repos (id PK, session_id FK, url, name, default_branch, branches JSON, fetched_at, UNIQUE(session_id, url))
        └─< comparisons (id PK, session_id FK, key, left_src JSON, right_src JSON,
                         left_label, right_label, compared_at, UNIQUE(session_id, key))
```

| Table         | Notes                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`       | Created on a user's first session. Usernames are already lowercased.                                                                                  |
| `sessions`    | Names are unique per user, ignoring case. `updated_at` changes when a repo is added or a comparison is run, and orders the sessions list.             |
| `repos`       | One row per repo URL per session. `branches` is a JSON array. Saving again (after a fetch) updates `branches`, `default_branch` and `fetched_at`.     |
| `comparisons` | `key` is `JSON.stringify([left, right])`, so running the same comparison again only refreshes `compared_at`. Only the newest 20 per session are kept. |

Times are ISO 8601 strings in UTC. IDs come from `crypto.randomUUID()`.

## Folders on disk

```
.data/
  om.db
  scratch/objects-*/                         temporary object folders for applicability (removed after each run)
  users/<username>/sessions/<sessionId>/
    repos/<repoId>/                          bare clone (git clone --bare --filter=blob:none)
    worktrees/<repoId>/<encoded-branch>/     one checkout per branch, tag or pinned SHA (git worktree, detached)
```

- **Folder names:** only the validated username and generated ids are used. Branch names are URL-encoded, so `feature/x` becomes `feature%2Fx`.
- **Deleting a session** removes its whole `sessions/<sessionId>/` folder.
- **A missing or broken clone** is rebuilt: adding the same URL again re-clones it under the same repo id. A broken worktree is removed and recreated.
