import { renameSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompareInputError } from '../src/errors.ts';
import { GitService, redactCredentials } from '../src/git/git-service.ts';
import { commit, createOrigin, git } from './git-fixtures.ts';

/*
 * One bare, blob-less repository holds several remotes. Each remote's branches live under
 * refs/remotes/<name>/ and its tags under refs/remote-tags/<name>/, so two remotes can both have a
 * branch called `dev` and each resolves to its own commit.
 */

let base: string;
let origin: { dir: string; url: string };
let fork: { dir: string; url: string };
let service: GitService;
let repoDir: string;

const sha = (cwd: string, rev: string) => git(cwd, 'rev-parse', rev).trim();

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-remotes-'));
  origin = createOrigin(path.join(base, 'origin'));
  fork = createOrigin(path.join(base, 'fork'));
  git(fork.dir, 'checkout', '-q', 'dev');
  commit(fork.dir, { 'fork.txt': 'only in the fork\n' }, 'fork work');
  git(fork.dir, 'tag', 'v1');
  git(fork.dir, 'checkout', '-q', 'main');

  service = new GitService({ allowedProtocols: ['https', 'ssh', 'file'] });
  repoDir = path.join(base, 'data', 'repo');
}, 120_000);

afterAll(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

describe('cloning a remote', () => {
  it('keeps its branches under its own name, and reports its default branch', async () => {
    const list = await service.clone(origin.url, repoDir);
    expect(list.defaultBranch).toBe('main');
    expect(list.branches).toEqual(['dev', 'feature/x', 'main']);
    const refs = git(repoDir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin');
    expect(refs.trim().split('\n')).toContain('refs/remotes/origin/main');
    expect(git(repoDir, 'config', '--get', 'remote.origin.promisor').trim()).toBe('true');
  }, 60_000);
});

describe('several remotes in one repo', () => {
  it('resolves the same branch name on two remotes to two commits', async () => {
    const list = await service.addRemote(repoDir, 'fork', fork.url);
    expect(list.branches).toContain('dev');
    const fromOrigin = await service.resolveCommit(repoDir, 'dev', 'origin');
    const fromFork = await service.resolveCommit(repoDir, 'dev', 'fork');
    expect(fromOrigin).toBe(sha(origin.dir, 'dev'));
    expect(fromFork).toBe(sha(fork.dir, 'dev'));
    expect(fromFork).not.toBe(fromOrigin);
  }, 60_000);

  it('resolves a tag within its own remote', async () => {
    expect(await service.resolveCommit(repoDir, 'v1', 'fork')).toBe(sha(fork.dir, 'v1'));
  });

  it('refuses a revision the remote does not have, and a remote that is not there', async () => {
    await expect(service.resolveCommit(repoDir, 'no-such-branch', 'fork')).rejects.toThrow(
      CompareInputError,
    );
    await expect(service.resolveCommit(repoDir, 'dev', 'ghost')).rejects.toThrow(CompareInputError);
  });

  it('fetches one remote and leaves the others as they were', async () => {
    const before = await service.resolveCommit(repoDir, 'dev', 'origin');
    git(fork.dir, 'checkout', '-q', 'dev');
    commit(fork.dir, { 'more.txt': 'more\n' }, 'fork dev moves');
    git(fork.dir, 'checkout', '-q', 'main');

    await service.fetchRemote(repoDir, 'fork');
    expect(await service.resolveCommit(repoDir, 'dev', 'fork')).toBe(sha(fork.dir, 'dev'));
    expect(await service.resolveCommit(repoDir, 'dev', 'origin')).toBe(before);
  }, 60_000);

  it('removes a remote with its branches and tags, and keeps the others', async () => {
    await service.addRemote(repoDir, 'temp', fork.url);
    expect(await service.resolveCommit(repoDir, 'v1', 'temp')).toBe(sha(fork.dir, 'v1'));

    await service.removeRemote(repoDir, 'temp');

    expect(git(repoDir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/temp')).toBe('');
    expect(git(repoDir, 'for-each-ref', '--format=%(refname)', 'refs/remote-tags/temp')).toBe('');
    expect(git(repoDir, 'remote').split('\n')).not.toContain('temp');
    await expect(service.resolveCommit(repoDir, 'dev', 'temp')).rejects.toThrow(CompareInputError);
    expect(await service.resolveCommit(repoDir, 'dev', 'origin')).toBe(sha(origin.dir, 'dev'));
  }, 60_000);
});

describe('writes and analysis on one repo', () => {
  it('holds an analysis command back while a write runs, and runs it after', async () => {
    let open: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const writing = service.exclusive(repoDir, () => held);
    let didRun = false;
    const reading = service.run(repoDir, ['rev-parse', 'HEAD']).then(() => {
      didRun = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(didRun).toBe(false);
    open();
    await Promise.all([writing, reading]);
    expect(didRun).toBe(true);
  }, 60_000);
});

describe('checking a remote', () => {
  it('reports a reachable remote, with no message', async () => {
    expect(await service.checkRemote(repoDir, 'origin')).toEqual({ reachable: true, message: '' });
  }, 60_000);

  it('reports why a remote is not reachable', async () => {
    const gone = createOrigin(path.join(base, 'gone'));
    await service.addRemote(repoDir, 'gone', gone.url);
    renameSync(gone.dir, `${gone.dir}-moved`);
    try {
      const result = await service.checkRemote(repoDir, 'gone');
      expect(result.reachable).toBe(false);
      expect(result.message).not.toBe('');
    } finally {
      renameSync(`${gone.dir}-moved`, gone.dir);
    }
  }, 60_000);

  it('removes credentials from git’s message', () => {
    expect(
      redactCredentials(
        "fatal: unable to access 'https://karthik:s3cret@example.com/acme.git/': denied",
      ),
    ).toBe("fatal: unable to access 'https://example.com/acme.git/': denied");
    expect(redactCredentials('fatal: no credentials here')).toBe('fatal: no credentials here');
  });
});
