import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe('clone, resolve and fetch', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = path.join(base, 'clone');
    await service.clone(origin.url, repoDir);
  });

  it('lists branches and the default branch', async () => {
    expect(await service.remoteBranches(repoDir, 'origin')).toEqual({
      defaultBranch: 'main',
      branches: ['dev', 'feature/x', 'main'],
    });
  });

  it('rejects an unknown branch', async () => {
    await expect(service.resolveCommit(repoDir, 'nope', 'origin')).rejects.toThrow(
      /branch "nope"/i,
    );
  });

  it('picks up new commits and branches only after fetching', async () => {
    const before = await service.resolveCommit(repoDir, 'main', 'origin');
    commit(origin.dir, { 'src/app.ts': 'export const v = 3;\n' }, 'main moves');
    git(origin.dir, 'checkout', '-q', '-b', 'hotfix');
    commit(origin.dir, { 'fix.txt': 'fix\n' }, 'hotfix');
    git(origin.dir, 'checkout', '-q', 'main');
    const moved = git(origin.dir, 'rev-parse', 'main');

    // Not fetched yet: the branch still resolves to the old commit.
    expect(await service.resolveCommit(repoDir, 'main', 'origin')).toBe(before);

    expect((await service.fetchRemote(repoDir, 'origin')).branches).toEqual([
      'dev',
      'feature/x',
      'hotfix',
      'main',
    ]);
    expect(await service.resolveCommit(repoDir, 'main', 'origin')).toBe(moved);
  });

  it('drops branches deleted on the remote when fetching', async () => {
    git(origin.dir, 'branch', '-q', '-D', 'hotfix');
    expect((await service.fetchRemote(repoDir, 'origin')).branches).not.toContain('hotfix');
  });
});

describe('clone errors', () => {
  it('reports a repo that cannot be cloned', async () => {
    const missing = new URL('file:///definitely/not/a/repo').href;
    await expect(service.clone(missing, path.join(base, 'bad'))).rejects.toThrow(CompareInputError);
    expect(existsSync(path.join(base, 'bad'))).toBe(false);
  });
});
