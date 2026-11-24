import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitCompareTrees, RepoInfo, SessionSummary } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { commit, createOrigin, git } from './git-fixtures.ts';

/*
 * Several remotes per repo, through the API: adding, fetching and removing one, the names and URLs
 * that must be unique, the per-repo limit, and comparing a branch on two remotes of one repo.
 */

const LIMITS = { sessionsPerUser: 10, reposPerSession: 10, remotesPerRepo: 2 };
const PROTOCOLS = ['https', 'ssh', 'file'];
const USER = 'remotes-user';

let base: string;
let app: FastifyInstance;
let origin: { dir: string; url: string };
let fork: { dir: string; url: string };
let third: { dir: string; url: string };

beforeAll(async () => {
  base = path.join(tmpdir(), `omr-${crypto.randomUUID().slice(0, 8)}`);
  origin = createOrigin(path.join(base, 'origin'));
  fork = createOrigin(path.join(base, 'fork'));
  third = createOrigin(path.join(base, 'third'));
  git(fork.dir, 'checkout', '-q', 'dev');
  commit(fork.dir, { 'fork.txt': 'only in the fork\n' }, 'fork work');
  git(fork.dir, 'checkout', '-q', 'main');
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: PROTOCOLS, limits: LIMITS });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

/** A session with the origin repo cloned into it. */
async function repoWithOrigin(name: string): Promise<{ sessionId: string; repo: RepoInfo }> {
  const session = (
    await app.inject({ method: 'POST', url: `/api/users/${USER}/sessions`, payload: { name } })
  ).json<SessionSummary>();
  const repo = (
    await app.inject({
      method: 'POST',
      url: `/api/users/${USER}/sessions/${session.id}/repos`,
      payload: { url: origin.url },
    })
  ).json<RepoInfo>();
  return { sessionId: session.id, repo };
}

const remotesUrl = (sessionId: string, repoId: string) =>
  `/api/users/${USER}/sessions/${sessionId}/repos/${repoId}/remotes`;

describe('adding a remote', () => {
  it('adds it under its own name, next to the first one', async () => {
    const { sessionId, repo } = await repoWithOrigin('add');
    const res = await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'fork', url: fork.url },
    });
    expect(res.statusCode).toBe(201);
    const updated = res.json<RepoInfo>();
    expect(updated.remotes.map((r) => r.name)).toEqual(['origin', 'fork']);
    expect(updated.remotes[1]?.branches).toContain('dev');
    expect(updated.url).toBe(origin.url);
  });

  it('refuses a name that is not a remote name, and a name or URL already in use', async () => {
    const { sessionId, repo } = await repoWithOrigin('clash');
    const bad = await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'Bad Name', url: fork.url },
    });
    expect(bad.statusCode).toBe(400);

    await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'fork', url: fork.url },
    });
    const sameName = await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'fork', url: origin.url },
    });
    expect(sameName.statusCode).toBe(409);
    expect(sameName.json<{ message: string }>().message).toContain('already has a remote named');

    const sameUrl = await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'mirror', url: fork.url },
    });
    expect(sameUrl.statusCode).toBe(409);
    expect(sameUrl.json<{ message: string }>().message).toContain('that URL');
  });

  it('refuses a remote beyond the per-repo limit', async () => {
    const { sessionId, repo } = await repoWithOrigin('limit');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: remotesUrl(sessionId, repo.id),
          payload: { name: 'fork', url: fork.url },
        })
      ).statusCode,
    ).toBe(201);
    const refused = await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'mirror', url: third.url },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toContain('2 remotes');
  });
});

describe('comparing across remotes', () => {
  it('compares the same branch on two remotes of one repo', async () => {
    const { sessionId, repo } = await repoWithOrigin('compare');
    await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'fork', url: fork.url },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/compare-trees',
      payload: {
        user: USER,
        sessionId,
        left: { type: 'git', repoId: repo.id, branch: 'dev' },
        right: { type: 'git', repoId: repo.id, branch: 'dev', remote: 'fork' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<GitCompareTrees>();
    expect(body.entries.find((e) => e.path === 'fork.txt')?.status).toBe('only-right');
  });

  it('answers 400 for a remote the repo does not have', async () => {
    const { sessionId, repo } = await repoWithOrigin('no-remote');
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/compare-trees',
      payload: {
        user: USER,
        sessionId,
        left: { type: 'git', repoId: repo.id, branch: 'dev', remote: 'ghost' },
        right: { type: 'git', repoId: repo.id, branch: 'dev' },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('fetching and removing a remote', () => {
  it('fetches one remote on its own', async () => {
    const { sessionId, repo } = await repoWithOrigin('fetch-one');
    await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'fork', url: fork.url },
    });
    const res = await app.inject({
      method: 'POST',
      url: `${remotesUrl(sessionId, repo.id)}/fork/fetch`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<RepoInfo>().remotes.map((r) => r.name)).toEqual(['origin', 'fork']);
  });

  it('removes a remote, but refuses to remove the last one', async () => {
    const { sessionId, repo } = await repoWithOrigin('remove');
    await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'fork', url: fork.url },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `${remotesUrl(sessionId, repo.id)}/fork`,
    });
    expect(removed.statusCode).toBe(204);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/users/${USER}/sessions/${sessionId}`,
    });
    expect(detail.json<{ repos: RepoInfo[] }>().repos[0]?.remotes.map((r) => r.name)).toEqual([
      'origin',
    ]);

    const last = await app.inject({
      method: 'DELETE',
      url: `${remotesUrl(sessionId, repo.id)}/origin`,
    });
    expect(last.statusCode).toBe(409);
    expect(last.json<{ message: string }>().message).toContain('at least one remote');

    const unknown = await app.inject({
      method: 'DELETE',
      url: `${remotesUrl(sessionId, repo.id)}/ghost`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('keeps the repo listed, under its other remote, when its origin is removed', async () => {
    const { sessionId, repo } = await repoWithOrigin('origin-gone');
    await app.inject({
      method: 'POST',
      url: remotesUrl(sessionId, repo.id),
      payload: { name: 'fork', url: fork.url },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `${remotesUrl(sessionId, repo.id)}/origin`,
    });
    expect(removed.statusCode).toBe(204);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/users/${USER}/sessions/${sessionId}`,
    });
    const [only] = detail.json<{ repos: RepoInfo[] }>().repos;
    expect(only?.remotes.map((r) => r.name)).toEqual(['fork']);
    expect(only?.url).toBe(fork.url);
  });
});

describe('checking a remote’s access', () => {
  it('answers whether the remote is reachable now', async () => {
    const { sessionId, repo } = await repoWithOrigin('check');
    const res = await app.inject({
      method: 'POST',
      url: `${remotesUrl(sessionId, repo.id)}/origin/check`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reachable: true, message: '' });
  });

  it('answers 404 for a remote the repo does not have', async () => {
    const { sessionId, repo } = await repoWithOrigin('check-ghost');
    const res = await app.inject({
      method: 'POST',
      url: `${remotesUrl(sessionId, repo.id)}/ghost/check`,
    });
    expect(res.statusCode).toBe(404);
  });
});
