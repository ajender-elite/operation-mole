# Git integration

Code: `apps/server/src/git/git-service.ts` (talks to git) and `apps/server/src/git/repo-manager.ts` (sessions, folders, locking).

## Why the git command line

OM runs the machine's own `git` through [simple-git](https://github.com/steveukx/git-js). Private repos then work exactly as they do in a terminal on that machine, through its SSH keys, agent and credential helpers. OM never asks for or stores credentials.

## Clones and branches

| Step             | Command(s)                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Clone            | `git clone --bare --filter=blob:none --quiet <url> <repoDir>`                                                       |
| List branches    | `git for-each-ref --format=%(refname:short) refs/heads`, sorted by `compareNames`                                   |
| Default branch   | `git symbolic-ref --short HEAD` (falls back to the first branch)                                                    |
| Resolve a branch | `git rev-parse --verify refs/remotes/<remote>/<b>^{commit}` (then the remote's tags, then a SHA)                    |
| Fetch latest     | `git fetch --prune origin +refs/heads/*:refs/heads/*`, then update `HEAD` from `git ls-remote --symref origin HEAD` |

Notes:

- **Bare and blob-less clones:** cloning only downloads history, and file contents arrive when an analysis needs them (in one batch per file, see `prefetchMissing`). Large repos stay quick to add, and one clone serves every branch and remote.
- **No checkouts:** comparisons read the trees of the two commits, so Left and Right can be two branches of the same repo at once without a folder for each. Nothing is written to the working tree of any clone.
- **Manual freshness:** nothing fetches on its own. Users click **Fetch latest** (in the Folders picker or the session overview).
- **Long paths:** simple-git commands run with `-c core.longpaths=true`. Windows git otherwise refuses to check out paths over 260 characters (nginx has them); other systems ignore it. It's set per command, never written to the user's config.

## Analysis commands

Diffs, blame, history and merge-tree run through `GitService.run`: git spawned directly (no shell) with the same environment allowlist, plus exit codes, abort signals and per-command environment, which simple-git doesn't expose. Every analysis command gets:

| Setting                                                                                                                    | Why                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `--literal-pathspecs`                                                                                                      | Paths from requests are never pathspec magic (`:(glob)…`)                         |
| `-c core.quotePath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false -c color.ui=never -c log.showSignature=false` | Output in the shape OM parses, whatever the machine's config                      |
| `-c gc.auto=0 -c maintenance.auto=false`                                                                                   | Lazy fetches add packs; automatic repacking must not run under concurrent readers |
| `GIT_OPTIONAL_LOCKS=0`                                                                                                     | Reads take no locks                                                               |

| Question                       | Command(s)                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot identity              | `rev-parse --verify refs/heads/<x>^{commit}`, then `refs/tags/<x>`, then `<sha>` (`resolveCommit`)                                                                   |
| Renames                        | `diff --name-status -z -M --diff-filter=R <left> <right>`                                                                                                            |
| One file's diff                | `ls-tree -z -l`, `cat-file blob`, `diff -U<n> --no-ext-diff --no-textconv <blob> <blob>`                                                                             |
| Current attribution            | `blame --porcelain -L a,b … <commit> -- <path>` on each line's own side                                                                                              |
| Reachability                   | `merge-base --is-ancestor <commit> <tip>` (cached)                                                                                                                   |
| Between (commits on each side) | `log --cherry-mark` / `patch-equivalents`: `log -z --left-right --cherry-mark --no-merges --max-count=N <left>...<right>`                                            |
| Series check                   | `merge-tree --write-tree -z --name-only --merge-base=<parent> <tree-or-commit> <commit>` per pick, in a scratch object store, then `diff-tree` for the changed paths |
| Patch equivalence              | `log --left-right --cherry-mark --no-merges <down>...<commit> ^<parent>`                                                                                             |
| Patch                          | `diff-tree -r -M -p <parent> <commit>` and `--name-status -z` for the file list                                                                                      |

**Object views.** The two snapshots may live in different clones (different remotes). An object view runs git in one clone with the other clone's `objects` folder in `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so one process sees both. Nothing is fetched between clones and no clone's config changes.

**Scratch objects.** `merge-tree` writes trees and blobs. It runs with `GIT_OBJECT_DIRECTORY` set to a new `<data>/scratch/objects-*` folder (the real object folders become alternates), removed afterwards on success, conflict, failure or abort.

**Blob-less clones.** Clones have no file contents until needed. Before blaming a file, or applying a commit, `prefetchMissing` lists the missing blobs (`rev-list --objects --missing=print … -- <paths>`) and fetches them in one request (`fetch --filter=blob:none origin <oids>`), instead of git's one-round-trip-per-object lazy fetch. On a real repository this took one file's blame from many seconds to under one. Failures are ignored; git still fetches lazily.

Analysis needs git **2.38 or later** (`merge-tree --write-tree`).

## The server's own git config

OM runs the server machine's git with that machine's configuration, on Linux, macOS and Windows alike: `~/.gitconfig` (or `%USERPROFILE%\.gitconfig`), `$XDG_CONFIG_HOME/git/config`, the system config, credential helpers (including Git Credential Manager, which needs `APPDATA`/`LOCALAPPDATA`) and SSH keys. The inherited variables cover what each OS needs to find these. Windows git also needs `SystemRoot` to open network sockets.

Setting `GIT_SSH_COMMAND` would override `core.sshCommand`, so at startup `configuredSshCommand()` reads it (outside any repo, so only system/global config apply), and OM uses it with `-o BatchMode=yes` appended.

## Locking

`GitService` keeps one read/write lock per repo folder. Each analysis command takes the shared side for its own duration, so analysis runs in parallel. Fetch, remote removal and repo deletion take the exclusive side: they wait for running commands and block new ones until they finish. A prune therefore never deletes a pack that a command is reading. Reachability checks run at most 8 at a time.

`RepoManager` runs at most one change at a time per `(session, repo URL)`: clone, fetch, remote changes or checkout. Different repos and sessions run in parallel.

## Security

| Risk                                                     | Mitigation                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local files or dangerous transports (`file://`, `ext::`) | `validateUrl` accepts only `https://`, `ssh://` and `user@host:path`. `GIT_ALLOW_PROTOCOL` also restricts what git itself may use, including submodules.                                        |
| Option injection (`--upload-pack=…`)                     | URLs starting with `-` or containing whitespace are rejected. URLs are passed as arguments, never through a shell.                                                                              |
| Hanging on a password or host-key prompt                 | `GIT_TERMINAL_PROMPT=0`, and `GIT_SSH_COMMAND` = the server's `core.sshCommand` (or `ssh`) plus `-o BatchMode=yes`, unless `GIT_SSH_COMMAND` is already set.                                    |
| Inherited git environment changing behavior              | Only an allowlist is passed on (`INHERITED_ENV` in `git-service.ts`): tools, home/config locations, temp dirs, SSH agent, proxies. simple-git also rejects unexpected ones (e.g. `GIT_EDITOR`). |
| Path traversal through names                             | Folders on disk use generated ids. Usernames are a strict slug. Branches are checked against `refs/heads/` and URL-encoded for folder names.                                                    |
| Using another user's repo                                | Every git source is checked against the requesting user's session and that session's repos (404 otherwise).                                                                                     |

Tests enable `file://` with `allowedProtocols: ['https', 'ssh', 'file']` so they can clone local repos. The app never enables it.

## Errors users see

| Situation                              | Message                                            |
| -------------------------------------- | -------------------------------------------------- |
| Bad URL                                | `Invalid repository URL: …`                        |
| Clone fails (not found, auth, network) | `Could not clone <url>: <git's error line>`        |
| Fetch fails                            | `Could not fetch: <git's error line>`              |
| Branch deleted or never fetched        | `Branch "<b>" not found. Try fetching the latest.` |
