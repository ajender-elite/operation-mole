import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitCompareTrees, RepoInfo, SessionDetail, SessionSummary } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createOrigin, git, commit } from './git-fixtures.ts';

let base: string;
let dataDir: string;
let origin: { dir: string; url: string };
let app: FastifyInstance;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-api-'));
  dataDir = path.join(base, 'data');
  origin = createOrigin(path.join(base, 'origin'));
  app = buildApp({ dataDir, allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const createSession = async (user: string, name: string) => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/users/${user}/sessions`,
    payload: { name },
  });
  return { res, session: res.json<SessionSummary>() };
};

const addRepo = (user: string, sessionId: string, url: string) =>
  app.inject({
    method: 'POST',
    url: `/api/users/${user}/sessions/${sessionId}/repos`,
    payload: { url },
  });

describe('sessions', () => {
  it('creates and lists a user’s sessions', async () => {
    const { res, session } = await createSession('alice', 'Release review');
    expect(res.statusCode).toBe(201);
    expect(session).toMatchObject({ name: 'Release review', repoCount: 0 });

    const list = await app.inject({ method: 'GET', url: '/api/users/alice/sessions' });
    expect(list.json<SessionSummary[]>().map((s) => s.name)).toEqual(['Release review']);
  });

  it('treats usernames case-insensitively', async () => {
    await createSession('Bob', 'One');
    const list = await app.inject({ method: 'GET', url: '/api/users/bob/sessions' });
    expect(list.json<SessionSummary[]>()).toHaveLength(1);
  });

  it('returns 409 for a duplicate session name', async () => {
    await createSession('carol', 'Same');
    const { res } = await createSession('carol', 'same');
    expect(res.statusCode).toBe(409);
  });

  it('validates usernames and session names', async () => {
    expect((await createSession('bad name', 'x')).res.statusCode).toBe(400);
    expect((await createSession('dave', '   ')).res.statusCode).toBe(400);
  });

  it('returns session details only to the owner', async () => {
    const { session } = await createSession('erin', 'Private');
    const own = await app.inject({ method: 'GET', url: `/api/users/erin/sessions/${session.id}` });
    expect(own.json<SessionDetail>()).toMatchObject({
      user: 'erin',
      session: { id: session.id },
      repos: [],
    });
    const other = await app.inject({
      method: 'GET',
      url: `/api/users/frank/sessions/${session.id}`,
    });
    expect(other.statusCode).toBe(404);
  });
});

describe('repos and git comparisons', () => {
  let sessionId: string;
  let repo: RepoInfo;

  beforeAll(async () => {
    sessionId = (await createSession('gita', 'Git work')).session.id;
  });

  it('clones a repo into the session and lists its branches', async () => {
    const res = await addRepo('gita', sessionId, origin.url);
    expect(res.statusCode).toBe(201);
    repo = res.json<RepoInfo>();
    expect(repo).toMatchObject({
      url: origin.url,
      name: 'origin',
      defaultBranch: 'main',
      branches: ['dev', 'feature/x', 'main'],
    });
    expect(
      existsSync(path.join(dataDir, 'users', 'gita', 'sessions', sessionId, 'repos', repo.id)),
    ).toBe(true);
  });

  it('reuses the existing clone when the same repo is added again', async () => {
    const again = await addRepo('gita', sessionId, `${origin.url}/`);
    expect(again.statusCode).toBe(200);
    expect(again.json<RepoInfo>().id).toBe(repo.id);
  });

  it('rejects invalid or unreachable repos', async () => {
    expect((await addRepo('gita', sessionId, 'not a url')).statusCode).toBe(400);
    const missing = await addRepo('gita', sessionId, 'file:///definitely/not/a/repo');
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ message: string }>().message).toMatch(/could not clone/i);
  });

  it('compares two branches of a repo, ignoring .git, and records it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/compare-trees',
      payload: {
        user: 'gita',
        sessionId,
        left: { type: 'git', repoId: repo.id, branch: 'main' },
        right: { type: 'git', repoId: repo.id, branch: 'dev' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<GitCompareTrees>().folder;
    expect(body.leftLabel).toBe('origin @ main');
    expect(body.rightLabel).toBe('origin @ dev');
    expect(body.root.children?.map((c) => [c.name, c.status])).toEqual([
      ['src', 'modified'],
      ['README.md', 'identical'],
    ]);
    expect(body.summary).toEqual({
      identical: 1,
      modified: 1,
      onlyLeft: 0,
      onlyRight: 1,
      errors: 0,
    });
  });

  it('returns 400 for an unknown branch and for a comparison without a session', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/git/compare-trees',
      payload: {
        user: 'gita',
        sessionId,
        left: { type: 'git', repoId: repo.id, branch: 'nope' },
        right: { type: 'git', repoId: repo.id, branch: 'main' },
      },
    });
    expect(unknown.statusCode).toBe(400);

    const noSession = await app.inject({
      method: 'POST',
      url: '/api/git/compare-trees',
      payload: {
        left: { type: 'git', repoId: repo.id, branch: 'main' },
        right: { type: 'git', repoId: repo.id, branch: 'dev' },
      },
    });
    expect(noSession.statusCode).toBe(400);
  });

  it('does not let another user use this session’s repos', async () => {
    const other = (await createSession('hank', 'Mine')).session.id;
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/compare-trees',
      payload: {
        user: 'hank',
        sessionId: other,
        left: { type: 'git', repoId: repo.id, branch: 'main' },
        right: { type: 'git', repoId: repo.id, branch: 'dev' },
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('fetches new branches and commits on request', async () => {
    git(origin.dir, 'checkout', '-q', '-b', 'release');
    commit(origin.dir, { 'release.txt': 'r\n' }, 'release');
    git(origin.dir, 'checkout', '-q', 'main');

    const res = await app.inject({
      method: 'POST',
      url: `/api/users/gita/sessions/${sessionId}/repos/${repo.id}/fetch`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<RepoInfo>().branches).toContain('release');
  });

  it('deletes a session and its cloned files', async () => {
    const sessionDir = path.join(dataDir, 'users', 'gita', 'sessions', sessionId);
    expect(existsSync(sessionDir)).toBe(true);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/gita/sessions/${sessionId}`,
    });
    expect(res.statusCode).toBe(204);
    expect(existsSync(sessionDir)).toBe(false);
    const after = await app.inject({ method: 'GET', url: `/api/users/gita/sessions/${sessionId}` });
    expect(after.statusCode).toBe(404);
  });
});
