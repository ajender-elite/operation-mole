<p align="center">
  <img src="apps/web/public/favicon.svg" alt="OM logo: a mole peeking out of its hill" width="96" />
</p>

<h1 align="center">OM · Operation Mole</h1>

<p align="center">Dig into two folders or git branches and see exactly what differs.</p>

---

## What it does

- **Sessions per user:** sign in with a username, then create or reopen a session. Each session keeps its own cloned repos.
- **Folders:** compare a **Left** and a **Right**, byte for byte, from their git trees. Each side is a git repository (given by its URL, since Left and Right may live on different remotes) and a branch you choose.
  - Green means only in left, blue means only in right, and orange means different. Identical entries keep the default color, and a folder gets an orange dot when something inside it differs.
  - Folders are listed first, then files, each in natural, case-insensitive order (`file2` before `file10`).
  - OM also explains the differences:
    - each side shows the exact commit it resolved to, and renamed files are linked;
    - files open in their own **File Compare** tab, as git's hunks;
    - on request (**Explain difference**), a side panel lists the commits that currently account for the differences in what you are looking at (the whole comparison, a folder, a file, a hunk, a line), from `git blame` on each line's own side, marking commits both histories share. Select a commit to see every difference it accounts for. Nothing is attributed until you ask.
- **Explore a repo:** on the Overview, **Browse code** opens a repo's default branch. The **Code** tab lists folders and files and shows each line with the commit that last changed it (blame, on by default; hide it with the **Blame** button). **Go to file** (press `t`) finds a file by part of its name; **/** opens **Search** (`git grep`, literal or regex). A folder's **Commits touching this folder** opens its own **Commits** tab, and each commit there opens as a patch. **Branches** lists every branch and tag of every remote, ahead and behind the default branch, and filters them by name. Code and Commits have a ref picker, so another branch or tag opens in its own tab. A blame tag's panel can also show the file before that change. A folder can be compared with another ref. A commit shows the branches and tags that contain it, and the Commits tab can list first-parent history or topological order. Press `?` for the list of shortcuts.
- **Series (cherry-pick sanity):** collect commits with **Add to series** (in Commits, Between or a commit), then check them, in order, on any branches of any remote. Each branch says whether the series applies, or where it stops and why (the conflicting paths with their text). Nothing is written to any repository. **Between** lists the commits on each side of two branches, marked only on the left, only on the right, or already picked across.
- **Light and dark mode:** switch with the sun/moon button at the top right.

## Quick start

You need **Node.js 26+** and **git** (`node -v`, `git --version`). The same steps work on Linux, macOS and Windows (Terminal, PowerShell or Command Prompt).

**If you have a release archive** (`om-<version>.tar.gz`, for example from a colleague), there is nothing to install or build:

```bash
tar -xzf om-<version>.tar.gz
cd om-<version>
node apps/server/src/index.ts --production
```

**If you cloned this repository**, install pnpm once, then build and run:

```bash
npm install -g pnpm@12.21.0
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Either way, open http://127.0.0.1:5181. Enter a username, create a session, and add a git repository URL; OM shows what you can do next.

To run OM on **another machine** without cloning there, make an archive with `pnpm release` (see [Build a release](#build-a-release-to-run-anywhere)) and copy `releases/om-<version>.tar.gz` over.

## Setup

### Requirements

| Tool    | Version                    | Check           |
| ------- | -------------------------- | --------------- |
| Node.js | 26 or later (`.nvmrc`)     | `node -v`       |
| pnpm    | 12.21.0 (`packageManager`) | `pnpm -v`       |
| git     | any recent version         | `git --version` |

Install pnpm once with `npm install -g pnpm@12.21.0`. Node 26 no longer bundles corepack. After that, use only pnpm in this repo, never `npm install`: `pnpm-lock.yaml` is the only lockfile. For a clean, reproducible install (CI), run `pnpm install --frozen-lockfile`.

OM uses Node's built-in SQLite (`node:sqlite`), so it needs no database server or extra installs.

It runs on **Linux, macOS and Windows**. Git uses the machine's own git config, credential helpers and SSH keys. OM's own git commands set `core.longpaths=true`, so repositories with paths longer than 260 characters (such as nginx) check out on Windows too. On Windows, the symlink tests are skipped unless symlinks can be created without admin rights: turn on **Developer Mode** (Settings → System → For developers) to run them.

### Install

From the project folder:

```bash
pnpm install
```

### Run in development

```bash
pnpm dev
```

This starts two processes:

| Process | URL                   | Notes                                                 |
| ------- | --------------------- | ----------------------------------------------------- |
| Web app | http://localhost:5180 | Open this one. Hot reload.                            |
| API     | http://127.0.0.1:5181 | Restarts on change. The web app proxies `/api` to it. |

Open http://localhost:5180, enter a username, create a session, then open **Folders**.

### Run in production

```bash
pnpm build
```

```bash
pnpm start
```

This serves the built app and the API together on http://127.0.0.1:5181. Pick another port with `--port 6000`, and reach it from other machines with `--host 0.0.0.0` (on a network you trust: anyone who can reach OM can read the folders and repositories it holds):

    node apps/server/src/index.ts --production --port 6000 --host 0.0.0.0

### Build a release to run anywhere

To run OM on another machine without cloning, installing or building there, make an archive on a machine that has this repository installed:

```bash
pnpm release
```

This creates `releases/om-<version>/` and `releases/om-<version>.tar.gz` (about 5 MB; `<version>` comes from `git describe`, with `-dirty` for uncommitted changes). The release holds the server, the built web app and its production dependencies. They are all plain JavaScript and TypeScript source, so the same archive runs on **Linux, macOS and Windows**. Before packing it, the script starts the release once and checks that the app and the API answer.

Copy the `.tar.gz` to the other machine and run it as in [Quick start](#quick-start); it needs only **Node.js 26+** and **git** there. `tar` is built into Windows 10 and later (Command Prompt or PowerShell), and Windows 11 File Explorer can also extract it. A `README.md` inside the archive repeats how to run it. The same environment variables apply (see [Configuration](#configuration)). Set `OM_DATA_DIR` to keep your sessions when you replace the folder with a newer release; by default they are in `.data/` inside it. `releases/` is not committed.

### Check against the real public test repository

```bash
pnpm test:remote
```

Needs the network. It checks that the pinned commits the offline tests use still exist on GitHub.

### Check everything

```bash
pnpm check
```

This runs type checks, lint (zero warnings allowed), a format check and all tests. Git tests create real temporary repos, so git must be installed. `pnpm test:coverage` also enforces 80% line and branch coverage. Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

The server reads a few optional environment variables (port, host, data folder). They're listed in [.env.example](.env.example).

## Using OM

### Users and sessions

1. **Username:** letters, digits, `.`, `-` or `_`. It's remembered on this device; **Switch user** on the sessions page clears it.
2. **Session:** create one or pick an existing one. Deleting a session also deletes every repo cloned in it.
3. **Overview:** with no repository yet, it only asks you to add one. Then it shows what you can do with it: compare two snapshots (**Compare folders**, or **Commits between** with the same choice), explore a repo (**Browse code**, **Branches**), and keep the repositories current with **Fetch latest**.
4. **Tabs:** each Folder Compare, File Compare, Code, Commits, Search, Branches, Series and Between opens in its own tab next to the Overview. Switching tabs keeps each one as you left it (folder, expanded rows, filters, scroll). Opening something that is already open focuses its tab instead of opening another. Open tabs survive a reload of the browser tab.

There are no passwords. Anyone who can reach the app and types your username can see your sessions, so only expose OM to people you trust.

### Comparing git branches

1. In **Folders**, for each of Left and Right, paste the repository URL and click **Clone**, or pick a repository already in the session. The two sides can use different remotes.
   - Supported URLs: `https://…`, `ssh://…` and `git@host:org/repo.git`.
   - Private repos work if the server machine's git can already reach them (SSH keys or a credential helper). OM never asks for or stores passwords or tokens.
2. Pick a branch for each side. Nothing is preselected, so you always choose it explicitly.
3. Click **Compare**.

How clones work:

- Each repo is cloned once per session. Adding the same URL again reuses that clone, and both sides can use different branches of the same repo.
- Clones download file contents only when a branch is checked out, which keeps cloning large repos fast.
- Nothing updates on its own. Click **Fetch latest** to pull new commits and branches.
- The repo's `.git` metadata is never shown as a difference.

### Moving around

- **Double-click** a folder, or press **Enter**, to open it. The breadcrumb takes you back up. Chevrons expand folders in place.
- **Double-click** a file to open it in a File Compare tab. **Folder compare** goes back to the folder tab as you left it; the arrows step through the other differences.
- **Explain difference** (on a differing row, on the current folder, or in File Compare) shows which commits account for exactly that difference. In a file, click a hunk header or a line to narrow it further. Close the panel to go back to just the difference.
- Everything is kept in the URL (session, sources, branches, current folder), so reloading, bookmarks and Back/Forward all work.

## Configuration

| Variable                                                                          | Default                 | Purpose                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OM_DATA_DIR`                                                                     | `.data/` in the project | Database and cloned repos. Excluded from git.                                                                                                                                        |
| `API_PORT`, or `--port <n>` on the command line (which wins)                      | `5181`                  | API port. The Vite proxy follows it in dev.                                                                                                                                          |
| `HOST`, or `--host <address>` on the command line (which wins)                    | `127.0.0.1`             | API bind address. `0.0.0.0` listens on every interface; anyone who can reach it can read the folders and repositories OM holds, so keep it on loopback unless you trust the network. |
| `OM_MAX_SESSIONS_PER_USER`, `OM_MAX_REPOS_PER_SESSION`, `OM_MAX_REMOTES_PER_REPO` | `10`                    | Limits on creating sessions, repos and remotes (enforced on the server).                                                                                                             |
| `OM_CACHE_MAX_MB`                                                                 | `256`                   | Size of the analysis cache per user, in megabytes.                                                                                                                                   |

### Where data lives

```
.data/
  users/<user>/user.db                              this user's sessions, repos, remotes and analysis cache
  users/<user>/sessions/<session>/repos/<repo>/     one clone per repo (all its remotes)
```

To start fresh, stop the server and delete `.data/`.

## Troubleshooting

| Symptom                                    | Fix                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Can't reach the OM API server"            | The API isn't running. Restart `pnpm dev` and check its output for errors.                                                                           |
| "Could not clone …: Authentication failed" | Make sure the machine running OM can run `git clone <url>` itself (SSH key or credential helper).                                                    |
| A branch you just pushed is missing        | Click **Fetch latest** for that repo.                                                                                                                |
| Port 5180 or 5181 is busy                  | Stop the other process, or pick another API port: `API_PORT=6000 pnpm dev` (the web app's proxy follows it), or `--port 6000` on a production start. |

## Project layout

```
apps/server        Fastify API. Node runs the TypeScript directly, so there's no build step.
  src/compare        folder rules on git trees, summary counts, sort order
  src/git-api        git primitives: log, show, blame, diff, merge-tree, compare-trees, patch-equivalents
  src/git            git service (clone, branches, fetch, locks) and per-session repo manager
  src/snapshot       file diffs (hunks), renames, ancestry
  src/cache          analysis cache: memory, then SQLite
  src/store          SQLite store for users, sessions, repos, remotes and the analysis cache
apps/web           React 19, Vite, Tailwind CSS v4, TanStack Query, React Router
packages/shared    API types and zod schemas used by both apps
```

Development is test-first:

- **Server tests** build real temporary folders and git repos.
- **Web tests** use Testing Library and mock the API with MSW.
