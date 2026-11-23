import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompareInputError } from '../src/errors.ts';
import { GitService, configuredSshCommand, gitEnvironment } from '../src/git/git-service.ts';
import { commit, createOrigin, git } from './git-fixtures.ts';

let base: string;
let origin: { dir: string; url: string };
const service = new GitService({ allowedProtocols: ['https', 'ssh', 'file'] });

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-git-'));
  origin = createOrigin(path.join(base, 'origin'));
});
afterAll(() => rm(base, { recursive: true, force: true }));

const read = (...parts: string[]) => readFileSync(path.join(...parts), 'utf8');

describe('validateUrl', () => {
  const strict = new GitService();

  it.each([
    'https://github.com/acme/app.git',
    'https://gitlab.example.com/group/sub/app',
    'ssh://git@github.com/acme/app.git',
    'git@github.com:acme/app.git',
  ])('accepts %s', (url) => {
    expect(() => {
      strict.validateUrl(url);
    }).not.toThrow();
  });

  it.each([
    'file:///etc',
    '/local/path',
    'http://insecure.example.com/a.git',
    'ext::sh -c touch% /tmp/pwned',
    '--upload-pack=touch /tmp/x',
    'https://github.com/a b.git',
    '',
  ])('rejects %s', (url) => {
    expect(() => {
      strict.validateUrl(url);
    }).toThrow(CompareInputError);
  });

  it('allows file:// only when configured', () => {
    expect(() => {
      service.validateUrl(origin.url);
    }).not.toThrow();
  });
});

describe('gitEnvironment', () => {
  const host = {
    // Linux / macOS
    PATH: '/usr/bin',
    HOME: '/home/me',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    TMPDIR: '/tmp',
    // Windows: git needs these to find its config, credentials and network stack
    USERPROFILE: 'C:\\Users\\me',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    PATHEXT: '.COM;.EXE',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    // Must never reach git
    GIT_EDITOR: 'vim',
    GIT_DIR: '/elsewhere',
    SECRET_TOKEN: 'x',
  };

  it('keeps what git needs on every platform and drops the rest', () => {
    const env = gitEnvironment(host, ['https', 'ssh']);
    for (const key of Object.keys(host).filter((k) => !/^(GIT_|SECRET)/.test(k))) {
      expect(env[key], key).toBe(host[key as keyof typeof host]);
    }
    expect(env).not.toHaveProperty('GIT_EDITOR');
    expect(env).not.toHaveProperty('GIT_DIR');
    expect(env).not.toHaveProperty('SECRET_TOKEN');
  });

  it('forces non-interactive git limited to the allowed protocols', () => {
    expect(gitEnvironment({}, ['https', 'ssh'])).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_ALLOW_PROTOCOL: 'https:ssh',
    });
  });

  it("keeps the server's own git config locations", () => {
    expect(gitEnvironment({ XDG_CONFIG_HOME: '/home/me/.config' }, [])).toMatchObject({
      XDG_CONFIG_HOME: '/home/me/.config',
    });
  });

  it("uses the server's core.sshCommand, still in batch mode", () => {
    const env = gitEnvironment({}, ['ssh'], 'C:/Windows/System32/OpenSSH/ssh.exe -i key');
    expect(env['GIT_SSH_COMMAND']).toBe(
      'C:/Windows/System32/OpenSSH/ssh.exe -i key -o BatchMode=yes',
    );
  });

  it('lets an explicit GIT_SSH_COMMAND win over core.sshCommand', () => {
    const env = gitEnvironment({ GIT_SSH_COMMAND: 'ssh -F cfg' }, ['ssh'], 'other-ssh');
    expect(env['GIT_SSH_COMMAND']).toBe('ssh -F cfg');
  });
});

describe("server's git config", () => {
  /** A machine whose only git config is `home`'s (no system config, no XDG config). */
  const machine = (home: string) => ({
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    USERPROFILE: home,
  });

  it('reads core.sshCommand from the git config git itself would use', () => {
    const home = path.join(base, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, '.gitconfig'), '[core]\n\tsshCommand = my-ssh -p 2222\n');
    expect(configuredSshCommand(machine(home))).toBe('my-ssh -p 2222');
  });

  it('is undefined when nothing is configured', () => {
    const home = path.join(base, 'empty-home');
    mkdirSync(home, { recursive: true });
    expect(configuredSshCommand(machine(home))).toBeUndefined();
  });
});

describe('repoName', () => {
  it.each([
    ['https://github.com/acme/app.git', 'app'],
    ['git@github.com:acme/my-lib.git', 'my-lib'],
    ['https://example.com/group/tool/', 'tool'],
  ])('%s -> %s', (url, name) => {
    expect(GitService.repoName(url)).toBe(name);
  });
});

describe('clone, checkout and fetch', () => {
  let repoDir: string;
  const wt = (branch: string) => path.join(base, 'worktrees', encodeURIComponent(branch));

  beforeAll(async () => {
    repoDir = path.join(base, 'clone');
    await service.clone(origin.url, repoDir);
  });

  it('lists branches and the default branch', async () => {
    expect(await service.branches(repoDir)).toEqual({
      defaultBranch: 'main',
      branches: ['dev', 'feature/x', 'main'],
    });
  });

  it('checks out a branch into its own folder', async () => {
    const main = await service.checkout(repoDir, 'main', wt('main'));
    expect(read(main, 'src', 'app.ts')).toBe('export const v = 1;\n');
    expect(existsSync(path.join(main, 'src', 'new.ts'))).toBe(false);
    // A worktree's .git is a file pointing back at the clone.
    expect(lstatSync(path.join(main, '.git')).isFile()).toBe(true);

    const dev = await service.checkout(repoDir, 'dev', wt('dev'));
    expect(read(dev, 'src', 'app.ts')).toBe('export const v = 2;\n');

    const feature = await service.checkout(repoDir, 'feature/x', wt('feature/x'));
    expect(read(feature, 'docs', 'x.md')).toBe('x\n');
  });

  it('reuses an existing checkout that is up to date', async () => {
    const first = await service.checkout(repoDir, 'main', wt('main'));
    const second = await service.checkout(repoDir, 'main', wt('main'));
    expect(second).toBe(first);
  });

  // Windows git refuses paths over 260 characters unless core.longpaths is on (nginx needs it).
  it('checks out files whose full path is longer than 260 characters', async () => {
    const deep = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(50)).join('/');
    const rel = `${deep}/long-name-file.txt`;
    const longOrigin = path.join(base, 'long-origin');
    mkdirSync(longOrigin);
    git(longOrigin, 'init', '-q', '-b', 'main');
    git(longOrigin, 'config', 'core.longpaths', 'true');
    commit(longOrigin, { [rel]: 'deep\n' }, 'long path');

    const longClone = path.join(base, 'long-clone');
    await service.clone(pathToFileURL(longOrigin).href, longClone);
    const checkout = await service.checkout(longClone, 'main', path.join(base, 'long-wt'));
    expect(path.join(checkout, rel).length).toBeGreaterThan(260);
    expect(read(checkout, ...rel.split('/'))).toBe('deep\n');
  });

  it('rejects an unknown branch', async () => {
    await expect(service.checkout(repoDir, 'nope', wt('nope'))).rejects.toThrow(/branch "nope"/i);
  });

  it('picks up new commits and branches only after fetching', async () => {
    commit(origin.dir, { 'src/app.ts': 'export const v = 3;\n' }, 'main moves');
    git(origin.dir, 'checkout', '-q', '-b', 'hotfix');
    commit(origin.dir, { 'fix.txt': 'fix\n' }, 'hotfix');
    git(origin.dir, 'checkout', '-q', 'main');

    // Not fetched yet: the old commit is still checked out.
    expect(read(await service.checkout(repoDir, 'main', wt('main')), 'src', 'app.ts')).toBe(
      'export const v = 1;\n',
    );

    expect((await service.fetch(repoDir)).branches).toEqual(['dev', 'feature/x', 'hotfix', 'main']);
    expect(read(await service.checkout(repoDir, 'main', wt('main')), 'src', 'app.ts')).toBe(
      'export const v = 3;\n',
    );
  });

  it('drops branches deleted on the remote when fetching', async () => {
    git(origin.dir, 'branch', '-q', '-D', 'hotfix');
    expect((await service.fetch(repoDir)).branches).not.toContain('hotfix');
  });
});

describe('clone errors', () => {
  it('reports a repo that cannot be cloned', async () => {
    const missing = new URL('file:///definitely/not/a/repo').href;
    await expect(service.clone(missing, path.join(base, 'bad'))).rejects.toThrow(CompareInputError);
    expect(existsSync(path.join(base, 'bad'))).toBe(false);
  });
});
