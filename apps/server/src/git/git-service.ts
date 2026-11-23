import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { compareNames } from '../compare/sort.ts';
import { CompareInputError, errorMessage } from '../errors.ts';

/** Output of {@link GitService.run}. */
export type GitRun = {
  stdout: string;
  exitCode: number;
};

/** Options for {@link GitService.run}. */
export type GitRunOptions = {
  /** Extra environment for this command (e.g. an object view's alternates). */
  env?: Record<string, string>;
  /** Kills git when aborted; the call then rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Exit codes that are answers rather than failures (e.g. 1 from `merge-base --is-ancestor`). */
  okExitCodes?: readonly number[];
  /** Fail instead of buffering more than this much output. Default 64 MB. */
  maxBytes?: number;
};

/** A git command that exited with an unexpected code. */
export class GitCommandError extends Error {
  override name = 'GitCommandError';
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Settings passed to every analysis command so that git's output has the shape OM parses,
 * whatever the machine's config says. They only affect formatting, never credentials.
 */
const ANALYSIS_ARGS = [
  // Paths from requests are literal paths, never pathspec magic like `:(exclude)`.
  '--literal-pathspecs',
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'color.ui=never',
  '-c',
  'log.showSignature=false',
  // Lazy fetches in a blob-less clone each add a pack; automatic housekeeping would then
  // repack under other analysis processes reading the same clone.
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
];

/** Object ids per `git fetch` when prefetching (keeps the command line short on Windows). */
const PREFETCH_BATCH = 500;

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Options for {@link GitService}. */
export type GitServiceOptions = {
  /** URL schemes allowed for cloning. scp-style `git@host:path` counts as `ssh`. */
  allowedProtocols?: string[];
};

/** Branches of a cloned repo, sorted with `compareNames`, and the remote default branch. */
export type BranchList = {
  defaultBranch: string;
  branches: string[];
};

/**
 * Inherited variables git needs on Linux, macOS and Windows: tools, home (git config,
 * credentials), temp dirs, SSH agent, proxies. Windows git can't find its config without
 * USERPROFILE/HOMEDRIVE/HOMEPATH, nor open network sockets without SystemRoot.
 */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];
const GIT_ENV = ['GIT_TERMINAL_PROMPT', 'GIT_SSH_COMMAND', 'GIT_ALLOW_PROTOCOL'];

type Env = Record<string, string | undefined>;

function inherit(source: Env, keys: string[]): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/**
 * The server's own `core.sshCommand` (from its system/global git config), if set.
 * Read once at startup: setting GIT_SSH_COMMAND would otherwise silently override it.
 */
export function configuredSshCommand(source: Env = process.env): string | undefined {
  try {
    const value = execFileSync('git', ['config', '--get', 'core.sshCommand'], {
      // Outside any repo, so only the machine's system and global config apply.
      cwd: tmpdir(),
      env: {
        ...inherit(source, [...INHERITED_ENV, 'GIT_CONFIG_NOSYSTEM']),
        GIT_CEILING_DIRECTORIES: tmpdir(),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value === '' ? undefined : value;
  } catch {
    // Exit code 1: not set.
    return undefined;
  }
}

/**
 * The environment git runs with: an allowlist of `source` (normally `process.env`), plus
 * settings that keep git non-interactive and limited to the allowed protocols. Git still
 * reads the server's own config (via HOME/USERPROFILE/XDG_CONFIG_HOME); a configured
 * `core.sshCommand` is kept, with batch mode added.
 */
export function gitEnvironment(
  source: Env,
  allowedProtocols: string[],
  sshCommand?: string,
): Record<string, string> {
  return {
    ...inherit(source, INHERITED_ENV),
    // Fail instead of waiting for a password or host-key prompt nobody can answer.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: source['GIT_SSH_COMMAND'] ?? `${sshCommand ?? 'ssh'} -o BatchMode=yes`,
    // Restrict transports git may use, including for submodules and redirects.
    GIT_ALLOW_PROTOCOL: allowedProtocols.join(':'),
  };
}

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;

/** First meaningful line of a git error, without the "fatal:" prefix. */
function gitError(err: unknown): string {
  const line = errorMessage(err)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^(fatal|error):/.test(l));
  return (line ?? errorMessage(err).split('\n')[0] ?? 'git failed').replace(
    /^(fatal|error):\s*/,
    '',
  );
}

/**
 * Clones and checks out repos with the machine's own git (so its SSH keys and
 * credential helpers work). Each repo is a bare, blob-less clone; each branch
 * is checked out into its own worktree folder.
 */
export class GitService {
  readonly #allowed: string[];
  readonly #env: Record<string, string>;

  constructor(options: GitServiceOptions = {}) {
    this.#allowed = options.allowedProtocols ?? ['https', 'ssh'];
    this.#env = gitEnvironment(process.env, this.#allowed, configuredSshCommand());
  }

  /**
   * Runs a read-only analysis command (diff, blame, log, merge-tree) and returns its output.
   * Unlike simple-git this exposes the exit code, extra environment and an abort signal,
   * which analysis needs. No shell is involved and the environment is the same allowlist.
   *
   * @throws GitCommandError when git exits with a code not in `okExitCodes` (default `[0]`).
   */
  async run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitRun> {
    const { stdout, exitCode } = await this.runBuffer(cwd, args, options);
    return { stdout: stdout.toString('utf8'), exitCode };
  }

  /** Like {@link run}, but returns raw bytes (for file contents). */
  runBuffer(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<{ stdout: Buffer; exitCode: number }> {
    const { env = {}, signal, okExitCodes = [0], maxBytes = DEFAULT_MAX_BYTES } = options;
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...ANALYSIS_ARGS, ...args], {
        cwd,
        env: { ...this.#env, GIT_OPTIONAL_LOCKS: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(signal ? { signal } : {}),
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let isTooLarge = false;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          isTooLarge = true;
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (signal?.aborted === true) return; // 'error' already rejected with an AbortError
        if (isTooLarge) {
          reject(
            new GitCommandError(`git ${args[0] ?? ''}: output larger than ${maxBytes} bytes`, -1),
          );
          return;
        }
        const exitCode = code ?? -1;
        if (!okExitCodes.includes(exitCode)) {
          reject(
            new GitCommandError(
              `git ${args[0] ?? ''}: ${gitError(stderr || `exit code ${exitCode}`)}`,
              exitCode,
            ),
          );
          return;
        }
        resolve({ stdout: Buffer.concat(chunks), exitCode });
      });
    });
  }

  /**
   * The full commit SHA for `rev`: a branch, then a tag, then a (possibly abbreviated) commit id.
   * Branches win over tags with the same name, as they do for comparisons everywhere else in OM.
   *
   * @throws CompareInputError when nothing matches.
   */
  async resolveCommit(repoDir: string, rev: string): Promise<string> {
    const candidates = [`refs/heads/${rev}`, `refs/tags/${rev}`];
    if (/^[0-9a-f]{4,64}$/i.test(rev)) candidates.push(rev.toLowerCase());
    const git = this.#git(repoDir);
    for (const candidate of rev.startsWith('-') ? [] : candidates) {
      const sha = (
        await git.raw(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).catch(() => '')
      ).trim();
      if (sha !== '') return sha;
    }
    throw new CompareInputError(`Branch "${rev}" not found. Try fetching the latest.`);
  }

  /** Whether a clone is blob-less (its origin is a promisor remote), cached per clone. */
  readonly #isPartial = new Map<string, Promise<boolean>>();

  async #isPartialClone(repoDir: string): Promise<boolean> {
    let answer = this.#isPartial.get(repoDir);
    if (answer === undefined) {
      answer = this.run(repoDir, ['config', '--get', 'remote.origin.promisor'], {
        okExitCodes: [0, 1],
      }).then(
        ({ stdout }) => stdout.trim() === 'true',
        () => false,
      );
      this.#isPartial.set(repoDir, answer);
    }
    return await answer;
  }

  /**
   * In a blob-less clone, downloads in one request the file contents that `revs` (limited to
   * `paths`) need and the clone doesn't have yet. Otherwise git fetches each one on demand:
   * for `git blame` over a long history that is hundreds of round trips. A no-op for full
   * clones. Failures are ignored, since git still fetches lazily when it needs an object.
   *
   * @param isWalking - include history (`rev-list`); false for just these commits' trees.
   */
  async prefetchMissing(
    repoDir: string,
    revs: readonly string[],
    paths: readonly string[],
    { isWalking = true, signal }: { isWalking?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (paths.length === 0 || !(await this.#isPartialClone(repoDir))) return;
    const opt = signal ? { signal } : {};
    try {
      const { stdout } = await this.run(
        repoDir,
        [
          'rev-list',
          '--objects',
          '--missing=print',
          ...(isWalking ? [] : ['--no-walk']),
          ...revs,
          '--',
          ...paths,
        ],
        opt,
      );
      const missing = stdout
        .split('\n')
        .filter((line) => line.startsWith('?'))
        .map((line) => line.slice(1).trim());
      for (let i = 0; i < missing.length; i += PREFETCH_BATCH) {
        await this.run(
          repoDir,
          [
            '-c',
            'fetch.negotiationAlgorithm=noop',
            'fetch',
            '--quiet',
            '--no-tags',
            '--no-write-fetch-head',
            '--recurse-submodules=no',
            '--filter=blob:none',
            'origin',
            ...missing.slice(i, i + PREFETCH_BATCH),
          ],
          opt,
        );
      }
    } catch (err) {
      if (signal?.aborted === true) throw err;
    }
  }

  #git(dir: string): SimpleGit {
    return simpleGit({ baseDir: dir, allowEnvironment: GIT_ENV }).env(this.#env);
  }

  /** Throws CompareInputError unless `url` is a remote git URL with an allowed scheme. */
  validateUrl(url: string): void {
    const bad = (reason: string) => new CompareInputError(`Invalid repository URL: ${reason}`);
    if (!url) throw bad('it is empty');
    if (/\s/.test(url) || url.startsWith('-')) throw bad(url);
    if (SCP_LIKE.test(url)) {
      if (!this.#allowed.includes('ssh')) throw bad('SSH URLs are not allowed');
      return;
    }
    let scheme: string;
    try {
      scheme = new URL(url).protocol.replace(/:$/, '');
    } catch {
      throw bad(`${url} (use https://…, ssh://… or git@host:path)`);
    }
    if (!this.#allowed.includes(scheme)) {
      throw bad(`${scheme}:// is not allowed (use ${this.#allowed.join(', ')})`);
    }
  }

  /** Short display name: the last path segment without `.git`. */
  static repoName(url: string): string {
    const last = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? url;
    return last.replace(/\.git$/, '') || url;
  }

  async clone(url: string, dir: string): Promise<BranchList> {
    this.validateUrl(url);
    await mkdir(path.dirname(dir), { recursive: true });
    try {
      await this.#git(path.dirname(dir)).clone(url, dir, [
        '--bare',
        '--filter=blob:none',
        '--quiet',
      ]);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw new CompareInputError(`Could not clone ${url}: ${gitError(err)}`);
    }
    return await this.branches(dir);
  }

  async branches(dir: string): Promise<BranchList> {
    const git = this.#git(dir);
    const refs = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    const branches = refs.split('\n').filter(Boolean).sort(compareNames);
    let defaultBranch = (await git.raw(['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
    if (!branches.includes(defaultBranch)) defaultBranch = branches[0] ?? '';
    return { defaultBranch, branches };
  }

  /** Updates all branches from the remote (removing deleted ones) and its default branch. */
  async fetch(dir: string): Promise<BranchList> {
    const git = this.#git(dir);
    try {
      await git.raw(['fetch', '--prune', '--quiet', 'origin', '+refs/heads/*:refs/heads/*']);
      const head = await git.raw(['ls-remote', '--symref', 'origin', 'HEAD']);
      const match = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head);
      const defaultBranch = match?.[1];
      if (defaultBranch !== undefined && defaultBranch !== '') {
        await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
      }
    } catch (err) {
      throw new CompareInputError(`Could not fetch: ${gitError(err)}`);
    }
    return await this.branches(dir);
  }

  /**
   * Ensures `worktreeDir` holds the commit `branch` resolves to (a branch tip, a tag or a
   * commit; see {@link resolveCommit}); returns the folder.
   */
  async checkout(repoDir: string, branch: string, worktreeDir: string): Promise<string> {
    const repo = this.#git(repoDir);
    const sha = await this.resolveCommit(repoDir, branch);

    if (existsSync(worktreeDir)) {
      const wt = this.#git(worktreeDir);
      const head = (await wt.revparse(['HEAD']).catch(() => '')).trim();
      if (head === sha) return worktreeDir;
      if (head) {
        await wt.raw(['checkout', '--quiet', '--force', '--detach', sha]);
        await wt.raw(['clean', '-f', '-d', '-x', '-q']);
        return worktreeDir;
      }
      // Not a working checkout (e.g. interrupted): start over.
      await rm(worktreeDir, { recursive: true, force: true });
    }
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await repo.raw(['worktree', 'prune']);
    await repo.raw(['worktree', 'add', '--quiet', '--detach', '--force', worktreeDir, sha]);
    return worktreeDir;
  }
}
