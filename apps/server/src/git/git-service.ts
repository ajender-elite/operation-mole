import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_REMOTE } from '@om/shared';
import { simpleGit, type SimpleGit } from 'simple-git';
import { compareNames } from '../compare/sort.ts';
import { CompareInputError, errorMessage } from '../errors.ts';
import { ReadWriteLock } from './repo-lock.ts';

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
  /** Written to the command's standard input (e.g. the diffs `patch-id` reads). */
  input?: string | Buffer;
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
/** Attempts for a read that Windows refused because a pack file was locked, and the first pause (then x2, x3). */
const PACK_LOCK_ATTEMPTS = 4;
const PACK_LOCK_DELAY_MS = 200;

/** Windows can refuse to open a pack file while a scanner or another git process holds it. */
function isPackLockError(err: unknown): boolean {
  return (
    err instanceof GitCommandError && /unable to open .*.pack: Permission denied/.test(err.message)
  );
}

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
/**
 * Removes the user and password from any URL in git's message, so a credential never reaches the
 * response (git echoes the URL it could not reach).
 */
export function redactCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s'"]+@/g, '//');
}

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
 * Clones and reads repos with the machine's own git (so its SSH keys and
 * credential helpers work). Each repo is one bare, blob-less clone holding all its remotes.
 */
/** The name of a repo's first remote, given by its clone. */
export const PRIMARY_REMOTE = DEFAULT_REMOTE;

export class GitService {
  readonly #allowed: string[];
  readonly #env: Record<string, string>;

  constructor(options: GitServiceOptions = {}) {
    this.#allowed = options.allowedProtocols ?? ['https', 'ssh'];
    this.#env = gitEnvironment(process.env, this.#allowed, configuredSshCommand());
  }

  /** The URL schemes git may use for remotes (`GIT_ALLOW_PROTOCOL`). */
  get allowedProtocols(): string[] {
    return [...this.#allowed];
  }

  /** Whether an SSH agent is reachable by git (`SSH_AUTH_SOCK` is set). Never the socket itself. */
  sshAgentAvailable(): boolean {
    const socket = process.env['SSH_AUTH_SOCK'];
    return socket !== undefined && socket !== '';
  }

  /** The version of the git the server runs, as git prints it (e.g. `2.47.0.windows.2`). */
  async version(): Promise<string> {
    const { stdout } = await this.run(tmpdir(), ['--version']);
    const match = /git version (\S+)/.exec(stdout);
    if (match?.[1] === undefined)
      throw new Error(`Unexpected output from git --version: ${stdout}`);
    return match[1];
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
    // Shared with other analysis commands; a write to the same repo (see exclusive) waits for it.
    return this.#lockFor(cwd).read(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.#runBufferOnce(cwd, args, options);
        } catch (err) {
          const isRetryable =
            attempt < PACK_LOCK_ATTEMPTS &&
            isPackLockError(err) &&
            options.signal?.aborted !== true;
          if (!isRetryable) throw err;
          // A scanner or another git process holds the pack for a moment; a retry reads it fine.
          await new Promise((resolve) => setTimeout(resolve, PACK_LOCK_DELAY_MS * attempt));
        }
      }
    });
  }

  #runBufferOnce(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions,
  ): Promise<{ stdout: Buffer; exitCode: number }> {
    const { env = {}, signal, okExitCodes = [0], maxBytes = DEFAULT_MAX_BYTES, input } = options;
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...ANALYSIS_ARGS, ...args], {
        cwd,
        env: { ...this.#env, GIT_OPTIONAL_LOCKS: '0', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
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
      // Nothing is written unless asked; stdin is closed either way, so git never waits for it.
      // git may exit before reading all of its input; that is git's answer, not a stream error.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
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
   * The full commit SHA for `rev` as `remote` has it: a branch of that remote, then a tag it
   * fetched, then a (possibly abbreviated) commit id.
   *
   * @throws CompareInputError when nothing matches.
   */
  async resolveCommit(repoDir: string, rev: string, remote: string): Promise<string> {
    const candidates = [`refs/remotes/${remote}/${rev}`, `refs/remote-tags/${remote}/${rev}`];
    if (/^[0-9a-f]{4,64}$/i.test(rev)) candidates.push(rev.toLowerCase());
    const git = this.#git(repoDir);
    for (const candidate of rev.startsWith('-') ? [] : candidates) {
      const sha = (
        await git.raw(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).catch(() => '')
      ).trim();
      if (sha !== '') return sha;
    }
    throw new CompareInputError(`Branch "${rev}" not found in ${remote}. Try fetching the latest.`);
  }

  /** Whether a remote of the repo is a promisor (a blob-less clone or fetch from it), cached per remote. */
  readonly #isPromisor = new Map<string, Promise<boolean>>();

  /** One read/write lock per repo folder (see {@link exclusive}). */
  readonly #locks = new Map<string, ReadWriteLock>();

  #lockFor(repoDir: string): ReadWriteLock {
    const key = path.resolve(repoDir);
    let lock = this.#locks.get(key);
    if (lock === undefined) {
      lock = new ReadWriteLock();
      this.#locks.set(key, lock);
    }
    return lock;
  }

  /**
   * Runs `task` with no analysis command in flight on this repo, and none starting until it
   * ends. Writes that change packs or refs (fetch, remove a remote's objects) use it, so a prune
   * never deletes a pack a git command is reading. Analysis commands take the shared side.
   */
  exclusive<T>(repoDir: string, task: () => Promise<T>): Promise<T> {
    return this.#lockFor(repoDir).write(task);
  }

  async #isPromisorRemote(repoDir: string, remote: string): Promise<boolean> {
    const key = `${repoDir}\n${remote}`;
    let answer = this.#isPromisor.get(key);
    if (answer === undefined) {
      answer = this.run(repoDir, ['config', '--get', `remote.${remote}.promisor`], {
        okExitCodes: [0, 1],
      }).then(
        ({ stdout }) => stdout.trim() === 'true',
        () => false,
      );
      this.#isPromisor.set(key, answer);
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
    {
      isWalking = true,
      signal,
      remote = PRIMARY_REMOTE,
    }: { isWalking?: boolean; signal?: AbortSignal; remote?: string } = {},
  ): Promise<void> {
    if (paths.length === 0 || !(await this.#isPromisorRemote(repoDir, remote))) return;
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
            remote,
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
    // core.longpaths: Windows git otherwise refuses checkouts with paths over 260 characters
    // (real repositories such as nginx have them). Other systems ignore it.
    return simpleGit({
      baseDir: dir,
      allowEnvironment: GIT_ENV,
      // No automatic repacking behind a clone or fetch: a background gc rewrites the packs that
      // analysis is reading at that moment (Windows refuses the rewrite and the read fails).
      config: ['core.longpaths=true', 'gc.auto=0', 'gc.autoDetach=false', 'maintenance.auto=false'],
    }).env(this.#env);
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

  /**
   * Creates the bare, blob-less repository at `dir`, with `origin` as its first remote. Returns the
   * remote's branches and default branch.
   */
  async clone(url: string, dir: string): Promise<BranchList> {
    this.validateUrl(url);
    await mkdir(dir, { recursive: true });
    try {
      await this.#git(dir).init(true);
      return await this.#connect(dir, PRIMARY_REMOTE, url, 'clone');
    } catch (err) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
      throw err;
    }
  }

  /**
   * Adds `name` as a remote of an existing repo, and fetches its branches and tags. Its branches are
   * kept apart from every other remote's (`refs/remotes/<name>/`), so the same branch name can mean
   * a different commit on each.
   */
  addRemote(dir: string, name: string, url: string): Promise<BranchList> {
    return this.exclusive(dir, () => this.#addRemote(dir, name, url));
  }

  async #addRemote(dir: string, name: string, url: string): Promise<BranchList> {
    this.validateUrl(url);
    return await this.#connect(dir, name, url, 'add');
  }

  /** Adds a remote (replacing a stale one of the same name) and fetches its branches and tags. */
  async #connect(
    dir: string,
    name: string,
    url: string,
    purpose: 'clone' | 'add',
  ): Promise<BranchList> {
    const git = this.#git(dir);
    try {
      // A name left by an interrupted add is replaced, so the add can be retried.
      await git.raw(['remote', 'remove', name]).catch(() => undefined);
      await git.raw(['remote', 'add', name, url]);
      // The fetch with a filter makes this remote a promisor: blobs are fetched on demand.
      await git.raw([
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--filter=blob:none',
        name,
      ]);
      await this.#fetchTags(dir, name);
    } catch (err) {
      throw new CompareInputError(`Could not ${purpose} ${url}: ${gitError(err)}`);
    }
    return await this.remoteBranches(dir, name);
  }

  async #fetchTags(dir: string, name: string): Promise<void> {
    await this.#git(dir).raw([
      'fetch',
      '--quiet',
      '--prune',
      '--no-tags',
      '--no-write-fetch-head',
      name,
      `+refs/tags/*:refs/remote-tags/${name}/*`,
    ]);
  }

  /** One remote's branches, and its default branch (its HEAD, when that is one of its branches). */
  async remoteBranches(dir: string, name: string): Promise<BranchList> {
    const git = this.#git(dir);
    const prefix = `refs/remotes/${name}/`;
    const refs = await git.raw(['for-each-ref', '--format=%(refname)', `refs/remotes/${name}`]);
    const branches = refs
      .split('\n')
      .filter((ref) => ref.startsWith(prefix))
      .map((ref) => ref.slice(prefix.length))
      .sort(compareNames);
    const head = await git.raw(['ls-remote', '--symref', name, 'HEAD']).catch(() => '');
    const match = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head);
    let defaultBranch = match?.[1] ?? '';
    if (!branches.includes(defaultBranch)) defaultBranch = branches[0] ?? '';
    return { defaultBranch, branches };
  }

  /**
   * Whether a remote answers now, with the same environment and no prompts as every other git call.
   * `ls-remote` reads only; it writes nothing to the clone. A failure carries git's reason.
   */
  async checkRemote(dir: string, name: string): Promise<{ reachable: boolean; message: string }> {
    try {
      await this.#git(dir).raw(['ls-remote', '--heads', name]);
      return { reachable: true, message: '' };
    } catch (err) {
      return { reachable: false, message: redactCredentials(gitError(err)) };
    }
  }

  /** Updates one remote's branches (removing deleted ones) and its tags. The others are untouched. */
  fetchRemote(dir: string, name: string): Promise<BranchList> {
    return this.exclusive(dir, () => this.#fetchRemote(dir, name));
  }

  async #fetchRemote(dir: string, name: string): Promise<BranchList> {
    const git = this.#git(dir);
    try {
      await git.raw(['fetch', '--prune', '--quiet', '--no-tags', '--no-write-fetch-head', name]);
      await this.#fetchTags(dir, name);
    } catch (err) {
      throw new CompareInputError(`Could not fetch ${name}: ${gitError(err)}`);
    }
    return await this.remoteBranches(dir, name);
  }

  /**
   * Removes a remote from the repo: its branches, its tags and its configuration. Then prunes the
   * objects only it referenced, under the caller's lock.
   */
  removeRemote(dir: string, name: string): Promise<void> {
    return this.exclusive(dir, () => this.#removeRemote(dir, name));
  }

  async #removeRemote(dir: string, name: string): Promise<void> {
    const git = this.#git(dir);
    const tags = (
      await git.raw(['for-each-ref', '--format=%(refname)', `refs/remote-tags/${name}`])
    )
      .split('\n')
      .filter(Boolean);
    await git.raw(['remote', 'remove', name]);
    for (const tag of tags) await git.raw(['update-ref', '-d', tag]);
    await git.raw(['gc', '--prune=now', '--quiet']);
  }
}
