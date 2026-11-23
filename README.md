<p align="center">
  <img src="apps/web/public/favicon.svg" alt="OM logo: a mole peeking out of its hill" width="96" />
</p>

<h1 align="center">OM · Operation Mole</h1>

<p align="center">Dig into two folders or git branches and see exactly what differs.</p>

---

## What it does

- **Sessions per user:** sign in with a username, then create or reopen a session. Each session keeps its own cloned repos and a list of recent comparisons.
- **Folders:** compare a **Base** and a **Target**, byte for byte. Each side is either a local folder or a branch of a git repo.
  - Green means only in base, blue means only in target, and orange means different. Identical entries keep the default color, and a folder gets an orange dot when something inside it differs.
  - Folders are listed first, then files, each in natural, case-insensitive order (`file2` before `file10`).
  - With two **git** snapshots (a branch, tag or commit on each side, from one remote or two), OM also explains the differences:
    - each side shows the exact commit it resolved to, and renamed files are linked;
    - a side panel lists the commits that currently account for the differences in whatever you focus (the whole repository, a folder, a file, a hunk, a line), from `git blame` on each line's own side, marking commits both histories share;
    - files open in place as git's hunks with each changed line's commit; select a commit to see every difference it accounts for.
- **Files:** a side-by-side or inline diff using Monaco, the diff editor from VS Code. Binary and very large files get a summary with size and SHA-256 instead.
- **Upstream:** pick an upstream and a downstream branch and a window of upstream commits (last N, since a date, mainline only, hide what downstream has). Each commit is applied on its own to the same downstream commit with `git merge-tree` and reported as **clean apply**, **already represented** (same commit, equivalent patch, or equivalent content), **conflicting apply** or **unknown**, with the evidence: per-file outcomes, conflict excerpts, equivalent commits and the patch. Nothing is written to any repository.
- **Light and dark mode:** switch with the sun/moon button at the top right.

## Setup

### Requirements

| Tool    | Version                    | Check           |
| ------- | -------------------------- | --------------- |
| Node.js | 26 or later (`.nvmrc`)     | `node -v`       |
| pnpm    | 12.21.0 (`packageManager`) | `pnpm -v`       |
| git     | any recent version         | `git --version` |

Install pnpm once with `npm install -g pnpm@12.21.0`. Node 26 no longer bundles corepack. After that, use only pnpm in this repo, never `npm install`: `pnpm-lock.yaml` is the only lockfile. For a clean, reproducible install (CI), run `pnpm install --frozen-lockfile`.

OM uses Node's built-in SQLite (`node:sqlite`), so it needs no database server or extra installs.

It runs on **Linux, macOS and Windows**. Git uses the machine's own git config, credential helpers and SSH keys. On Windows, two optional settings make the symlink examples real symlinks (otherwise git checks them out as small text files and the symlink tests are skipped):

1. Turn on **Developer Mode** (Settings → System → For developers), so symlinks can be created without admin rights.
2. Clone with `git clone -c core.symlinks=true …`. In an existing clone, run `git config core.symlinks true`, delete the `examples` folder, then run `git checkout -- examples` and `pnpm install` (which recreates the empty example folders).

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

This serves the built app and the API together on http://127.0.0.1:5181.

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

The server reads a few optional environment variables (port, host, default folders, data folder). They're listed in [.env.example](.env.example).

## Using OM

### Users and sessions

1. **Username:** letters, digits, `.`, `-` or `_`. It's remembered on this device; **Switch user** on the sessions page clears it.
2. **Session:** create one or pick an existing one. Deleting a session also deletes every repo cloned in it.
3. **Overview:** shows the session's recent comparisons (click one to reopen it) and its repositories, each with a **Fetch latest** button.

There are no passwords. Anyone who can reach the app and types your username can see your sessions, so only expose OM to people you trust.

### Comparing git branches

1. In **Folders**, switch Base or Target from **Folder** to **Git repo**.
2. Choose a repo already in the session, or choose **Add a repository…**, paste its URL and click **Clone**.
   - Supported URLs: `https://…`, `ssh://…` and `git@host:org/repo.git`.
   - Private repos work if the server machine's git can already reach them (SSH keys or a credential helper). OM never asks for or stores passwords or tokens.
3. Pick a branch. It defaults to the repo's default branch.
4. Click **Compare**.

How clones work:

- Each repo is cloned once per session. Adding the same URL again reuses that clone, and both sides can use different branches of the same repo.
- Clones download file contents only when a branch is checked out, which keeps cloning large repos fast.
- Nothing updates on its own. Click **Fetch latest** to pull new commits and branches.
- The repo's `.git` metadata is never shown as a difference.

### Moving around

- **Double-click** a folder, or press **Enter**, to open it. The breadcrumb takes you back up. Chevrons expand folders in place.
- **Double-click** a file to open its diff. The back link returns you to the same folder.
- To compare two files with different names: hover one, click **Select for compare**, then click **Compare with selected** on the other.
- Everything is kept in the URL (session, sources, branches, current folder), so reloading, bookmarks and Back/Forward all work.

## Configuration

| Variable               | Default                            | Purpose                                                                                                           |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `OM_DATA_DIR`          | `.data/` in the project            | Database and cloned repos. Excluded from git.                                                                     |
| `OM_LEFT` / `OM_RIGHT` | `examples/left` / `examples/right` | Folders a new comparison opens with                                                                               |
| `API_PORT`             | `5181`                             | API port                                                                                                          |
| `HOST`                 | `127.0.0.1`                        | API bind address. The API reads any local path and runs git, so keep it on loopback unless you trust the network. |

### Where data lives

```
.data/
  om.db                                             users, sessions, repos, recent comparisons
  users/<user>/sessions/<session>/repos/<repo>/     one clone per repo
  users/<user>/sessions/<session>/worktrees/<repo>/<branch>/   one checkout per branch
```

To start fresh, stop the server and delete `.data/`.

## Troubleshooting

| Symptom                                    | Fix                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| "Can't reach the OM API server"            | The API isn't running. Restart `pnpm dev` and check its output for errors.                        |
| "Could not clone …: Authentication failed" | Make sure the machine running OM can run `git clone <url>` itself (SSH key or credential helper). |
| A branch you just pushed is missing        | Click **Fetch latest** for that repo.                                                             |
| Port 5180 or 5181 is busy                  | Stop the other process, or set `API_PORT` and change `server.port` in `apps/web/vite.config.ts`.  |

## Project layout

```
apps/server        Fastify API. Node runs the TypeScript directly, so there's no build step.
  src/compare        folder walk, byte comparison, sort order
  src/files          reads file content for the diff view
  src/git            git service (clone, branches, worktrees, fetch) and per-session repo manager
  src/store          SQLite store for users, sessions, repos and recent comparisons
apps/web           React 19, Vite, Tailwind CSS v4, TanStack Query, React Router, Monaco
packages/shared    API types and zod schemas used by both apps
examples/          sample folders covering every comparison case (see examples/README.md)
```

Development is test-first:

- **Server tests** build real temporary folders and git repos.
- **Web tests** use Testing Library and mock the API with MSW.
