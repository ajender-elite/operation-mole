import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Deterministic git histories for OM's analysis tests.
 *
 * Every scenario starts from a pinned public seed: octocat/Hello-World at commit
 * {@link SEED_COMMIT}, frozen in `seed/hello-world.bundle` so the normal suite never needs
 * the network (`test/remote/` checks the bundle against GitHub). On top of it, tests build
 * exactly the history they need. Authors, committers, dates and messages are all fixed, and
 * git runs without any global or system config (no user identity, aliases or hooks).
 */
export const SEED_BUNDLE = fileURLToPath(new URL('seed/hello-world.bundle', import.meta.url));
/** "Merge pull request #6 from Spaceghost/patch-1": a merge with two parents. */
export const SEED_COMMIT = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
/** "first commit": README with "Hello World!" and no final newline. */
export const SEED_FIRST = '553c2077f0edc3d5dc5d17262f6aa498e69d6f8e';
/** "New line at end of file. --Signed off by Spaceghost" */
export const SEED_NEWLINE = '762941318ee16e59dabbacb1b4049eec22f0d303';

/** A fixed identity: tests compare names, so nothing comes from the machine. */
export type Person = { name: string; email: string };
export const ALICE: Person = { name: 'Alice Upstream', email: 'alice@example.com' };
export const BOB: Person = { name: 'Bob Downstream', email: 'bob@example.com' };

/** 2026-01-01T00:00:00Z; each commit is one hour after the previous one. */
const START = Date.UTC(2026, 0, 1) / 1000;

/** The test process's environment without any GIT_* variable, and with no global/system config. */
const isolatedEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/** A repository with a controlled history, built on the pinned seed. */
export class Scenario {
  readonly dir: string;
  #clock: number;

  private constructor(dir: string, clock: number) {
    this.dir = dir;
    this.#clock = clock;
  }

  /** A new repo at `dir` on branch `main`, at the pinned seed commit. */
  static fromSeed(dir: string): Scenario {
    mkdirSync(dir, { recursive: true });
    const scenario = new Scenario(dir, START);
    scenario.git('init', '-q', '-b', 'main');
    // Serve partial clones, so OM's `--filter=blob:none` clones of this repo really are
    // blob-less (as they are from GitHub), and lazy fetching is exercised too.
    scenario.git('config', 'uploadpack.allowFilter', 'true');
    scenario.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    scenario.git('fetch', '-q', SEED_BUNDLE, 'refs/heads/pinned:refs/heads/seed');
    scenario.git('checkout', '-q', '-B', 'main', SEED_COMMIT);
    if (scenario.rev('HEAD') !== SEED_COMMIT) throw new Error('seed bundle does not match');
    return scenario;
  }

  /** An independent clone (another "remote"), continuing the same clock. */
  fork(dir: string): Scenario {
    execFileSync('git', ['clone', '-q', '--no-local', this.dir, dir], { env: isolatedEnv() });
    return new Scenario(dir, this.#clock + 3600 * 1000);
  }

  /** `file://` URL for cloning into OM. */
  get url(): string {
    return pathToFileURL(this.dir).href;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.dir,
      env: isolatedEnv(),
      encoding: 'utf8',
    }).trim();
  }

  #identity(author: Person, committer: Person): NodeJS.ProcessEnv {
    this.#clock += 3600;
    const date = `@${this.#clock} +0000`;
    return {
      ...isolatedEnv(),
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: date,
    };
  }

  /**
   * Writes files (`null` deletes; a Buffer is written as bytes) and commits them on the current
   * branch. Returns the new commit's SHA.
   */
  commit(
    files: Record<string, string | Buffer | null>,
    message: string,
    { author = ALICE, committer = author }: { author?: Person; committer?: Person } = {},
  ): string {
    for (const [rel, contents] of Object.entries(files)) {
      const file = path.join(this.dir, ...rel.split('/'));
      if (contents === null) rmSync(file, { recursive: true, force: true });
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, contents);
      }
    }
    this.git('add', '-A');
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
      cwd: this.dir,
      env: this.#identity(author, committer),
    });
    return this.rev('HEAD');
  }

  /** Renames with `git mv` (plus optional edits) in one commit. */
  move(from: string, to: string, message: string, edits: Record<string, string> = {}): string {
    mkdirSync(path.dirname(path.join(this.dir, ...to.split('/'))), { recursive: true });
    this.git('mv', from, to);
    return this.commit(edits, message);
  }

  /** Creates or resets `name` at `from` (default HEAD) and checks it out. */
  branch(name: string, from = 'HEAD'): void {
    this.git('checkout', '-q', '-B', name, from);
  }

  checkout(name: string): void {
    this.git('checkout', '-q', name);
  }

  /** `git cherry-pick` with a fixed committer (a new SHA, the same patch). */
  cherryPick(commit: string, committer: Person = BOB): string {
    execFileSync('git', ['cherry-pick', '--allow-empty', commit], {
      cwd: this.dir,
      env: this.#identity(committer, committer),
      stdio: 'ignore',
    });
    return this.rev('HEAD');
  }

  /** `git merge --no-ff` with a fixed identity. */
  merge(ref: string, message: string, person: Person = ALICE): string {
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', message, ref], {
      cwd: this.dir,
      env: this.#identity(person, person),
      stdio: 'ignore',
    });
    return this.rev('HEAD');
  }

  tag(name: string, ref = 'HEAD'): void {
    this.git('tag', name, ref);
  }

  rev(ref: string): string {
    return this.git('rev-parse', `${ref}^{commit}`);
  }
}

/**
 * Everything about a repository that analysis must never change: refs, HEAD, status,
 * in-progress operation markers, and every file in its git directory (with sizes).
 */
export function repoState(gitDir: string, worktree?: string): string {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: isolatedEnv(), encoding: 'utf8' }).trim();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else files.push(`${path.relative(gitDir, abs)} ${stat.size}`);
    }
  };
  walk(gitDir);
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'].filter((m) =>
    existsSync(path.join(gitDir, m)),
  );
  return JSON.stringify(
    {
      refs: run(gitDir, 'for-each-ref', '--format=%(refname) %(objectname)'),
      head: run(gitDir, 'rev-parse', 'HEAD'),
      objects: run(gitDir, 'count-objects', '-v'),
      status: worktree === undefined ? '' : run(worktree, 'status', '--porcelain'),
      markers,
      files,
    },
    null,
    1,
  );
}
