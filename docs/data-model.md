# Data model

All state lives under the data folder: `OM_DATA_DIR`, by default `.data/` in the project, which is excluded from git. To reset everything, stop the server and delete the folder.

## SQLite: one database per user

Each user has their own database: `.data/users/<user>/user.db`. Opened with Node's built-in `node:sqlite` (`DatabaseSync`) in `apps/server/src/store/`:

- `schema.ts` holds the schema and applies it. The version is `PRAGMA user_version`; a database with a newer version than this OM is refused, not guessed at.
- `store.ts` (`Store`) is one user's sessions, repos, remotes and cache, in that user's file. Its methods take no user name, because the file is the user.
- `store-registry.ts` (`StoreRegistry`) opens user files on demand. `read(user)` returns nothing for a user with no file and creates nothing (a read); `write(user)` creates the file (a write). At most 32 files are open; the least recently used is closed.

A user exists when their folder exists. There is no shared database, so one user's queries cannot see another user's rows.

Foreign keys are on, so deleting a row deletes what depends on it. Columns are snake_case; queries alias them to the API's camelCase names, and every row is parsed with a zod schema rather than cast.

### Schema (version 3)

Version 3 dropped the recent comparisons: a version 2 file loses its `comparisons` table on open, and keeps everything else.

```
sessions (id PK, name, created_at, updated_at, UNIQUE(name COLLATE NOCASE))
  ├─< repos (id PK, session_id FK, name, created_at)
  │     ├─< remotes (id PK, repo_id FK, name, url, default_branch, branches JSON, fetched_at,
  │     │            UNIQUE(repo_id, name), UNIQUE(repo_id, url))
  │     └─< analysis_cache (repo_id FK, key, value JSON, bytes, created_at, last_used,
  │                         PRIMARY KEY(repo_id, key))
```

| Table            | Notes                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`       | Names are unique per user file, ignoring case. `updated_at` changes when a repo is added or a comparison is run, and orders the list.                                                                                                                         |
| `repos`          | The repo's name and identity. Its URL and branches live on a remote.                                                                                                                                                                                          |
| `remotes`        | One or more per repo: a name and URL (both unique within the repo), and what its last fetch found. The first is `origin`, the URL the repo was cloned from. `OM_MAX_REMOTES_PER_REPO` caps them.                                                              |
| `analysis_cache` | Results of analysis (file diffs, ancestry, applicability), keyed by commit SHAs and never branch names, so entries never go stale. Capped per user by `OM_CACHE_MAX_MB` (default 256); the least recently used go first. Deleting a repo deletes its entries. |

Times are ISO 8601 strings in UTC. IDs come from `crypto.randomUUID()`.

### Caching is swappable

Analysis code asks for results through `AnalysisCache.remember` (`apps/server/src/cache/analysis-cache.ts`): it computes a result once, serves repeats, and shares one computation between callers who ask at the same time. A failed computation, or one the caller marks as not cacheable (ancestry that git could not tell, an applicability error), is never kept. Results are read back through their schema, so a stored value of the wrong shape is recomputed.

Below that sits a `CacheStorage`: `StoreCacheStorage` keeps results in each user's `analysis_cache` table (the default), and `MemoryCacheStorage` keeps them in the process only (tests, and the default when no storage is given). Another backend can replace either without touching the analyzers. A memory tier sits in front of the storage.

Entries carry `CACHE_VERSION`. Bump it when a result's meaning or shape changes: entries written under another version are never read, and they age out with the rest.

A result belongs to one repo (its scope is the repo's user and id). Deleting a repo, or removing one of its remotes, purges that repo's results. A result that involves two repos (the upstream applicability, which applies a commit of one repo to another) is kept under the downstream repo, the one its result is about.

### Previous data

The previous single database (`.data/om.db`, schema version 1) is not read by this version, and no migration is written for it. Start fresh: delete `.data/om.db` and the old `.data/users/*/sessions` folders if you want the disk tidy. The clones under the old layout are ignored, not converted.

## Folders on disk

```
.data/
  users/<username>/user.db                  this user's SQLite database (sessions, repos, remotes, cache)
  scratch/objects-*/                         temporary object folders for merge-tree (removed after each run)
  users/<username>/sessions/<sessionId>/
    repos/<repoId>/                          bare clone (git clone --bare --filter=blob:none), holding all its remotes
```

- **Refs in the bare clone:** each remote's branches live under `refs/remotes/<remote>/<branch>` and its tags under `refs/remote-tags/<remote>/<tag>`, so two remotes can both have a `dev` branch. Each remote is a promisor (`remote.<name>.promisor=true`), so missing file contents are fetched from the remote they belong to.
- **Folder names:** only the validated username and generated ids are used. Branch names are URL-encoded, so `feature/x` becomes `feature%2Fx`.
- **Deleting a session** removes its whole `sessions/<sessionId>/` folder.
- **A missing or broken clone** is rebuilt: adding the same URL again re-clones it under the same repo id.
