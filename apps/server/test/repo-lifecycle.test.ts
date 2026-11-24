import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerInfo, SessionDetail, SessionSummary } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createOrigin } from './git-fixtures.ts';

/*
 * Limits, deleting repositories and sessions, the startup sweep and GET /api/server. The limits are
 * small so the tests stay fast; the defaults (10 each) come from the server config.
 */

const LIMITS = { sessionsPerUser: 2, reposPerSession: 2, remotesPerRepo: 10 };
const PROTOCOLS = ['https', 'ssh', 'file'];

let base: string;
let dataDir: string;
let app: FastifyInstance;
let origins: Array<{ dir: string; url: string }>;

beforeAll(() => {
  base = path.join(tmpdir(), `om-lifecycle-${crypto.randomUUID()}`);
  dataDir = path.join(base, 'data');
  origins = [1, 2, 3].map((n) => createOrigin(path.join(base, `origin-${n}`)));
  app = buildApp({ dataDir, allowedProtocols: PROTOCOLS, limits: LIMITS });
}, 120_000);

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

const sessionsOf = (user: string) => `/api/users/${user}/sessions`;
const sessionOf = (user: string, sessionId: string) => `${sessionsOf(user)}/${sessionId}`;

const createSession = async (user: string, name: string) => {
  const res = await app.inject({ method: 'POST', url: sessionsOf(user), payload: { name } });
  return { res, session: res.json<SessionSummary>() };
};

const addRepo = (user: string, sessionId: string, url: string) =>
  app.inject({ method: 'POST', url: `${sessionOf(user, sessionId)}/repos`, payload: { url } });

const repoFolder = (user: string, sessionId: string, repoId: string) =>
  path.join(dataDir, 'users', user, 'sessions', sessionId, 'repos', repoId);

const detail = async (user: string, sessionId: string) =>
  (await app.inject({ method: 'GET', url: sessionOf(user, sessionId) })).json<SessionDetail>();

describe('limits on creating', () => {
  it('refuses a session beyond the per-user limit, and creates nothing', async () => {
    expect((await createSession('limited', 'one')).res.statusCode).toBe(201);
    expect((await createSession('limited', 'two')).res.statusCode).toBe(201);
    const { res } = await createSession('limited', 'three');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toContain('2 sessions');
    const list = await app.inject({ method: 'GET', url: sessionsOf('limited') });
    expect(list.json<SessionSummary[]>()).toHaveLength(2);
  });

  it('refuses a repo beyond the per-session limit, and still answers for one already there', async () => {
    const { session } = await createSession('repo-limit', 'busy');
    expect((await addRepo('repo-limit', session.id, origins[0]!.url)).statusCode).toBe(201);
    expect((await addRepo('repo-limit', session.id, origins[1]!.url)).statusCode).toBe(201);

    const refused = await addRepo('repo-limit', session.id, origins[2]!.url);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toContain('2 repositories');
    expect((await detail('repo-limit', session.id)).repos).toHaveLength(2);

    const again = await addRepo('repo-limit', session.id, origins[0]!.url);
    expect(again.statusCode).toBe(200);
  });
});

describe('deleting a repository', () => {
  it('removes its row and clone, leaves the others, and frees a slot', async () => {
    const { session } = await createSession('deleter', 'clean-up');
    const kept = (await addRepo('deleter', session.id, origins[0]!.url)).json<{ id: string }>();
    const removed = (await addRepo('deleter', session.id, origins[1]!.url)).json<{ id: string }>();
    expect(existsSync(repoFolder('deleter', session.id, removed.id))).toBe(true);

    const res = await app.inject({
      method: 'DELETE',
      url: `${sessionOf('deleter', session.id)}/repos/${removed.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(existsSync(repoFolder('deleter', session.id, removed.id))).toBe(false);
    expect((await detail('deleter', session.id)).repos.map((r) => r.id)).toEqual([kept.id]);
    expect(existsSync(repoFolder('deleter', session.id, kept.id))).toBe(true);

    const again = await app.inject({
      method: 'DELETE',
      url: `${sessionOf('deleter', session.id)}/repos/${removed.id}`,
    });
    expect(again.statusCode).toBe(404);

    expect((await addRepo('deleter', session.id, origins[2]!.url)).statusCode).toBe(201);
  });

  it('deletes the clones with their session', async () => {
    const { session } = await createSession('deleter', 'to-go');
    const repo = (await addRepo('deleter', session.id, origins[0]!.url)).json<{ id: string }>();
    expect(existsSync(repoFolder('deleter', session.id, repo.id))).toBe(true);

    const res = await app.inject({ method: 'DELETE', url: sessionOf('deleter', session.id) });
    expect(res.statusCode).toBe(204);
    expect(existsSync(path.join(dataDir, 'users', 'deleter', 'sessions', session.id))).toBe(false);
  });
});

describe('startup sweep', () => {
  it('removes repository and session folders that have no row', async () => {
    const { session } = await createSession('sweeper', 'kept');
    const kept = (await addRepo('sweeper', session.id, origins[0]!.url)).json<{ id: string }>();
    const stray = path.join(dataDir, 'users', 'sweeper', 'sessions', session.id, 'repos', 'stray');
    const ghost = path.join(dataDir, 'users', 'sweeper', 'sessions', 'ghost', 'repos', 'x');
    mkdirSync(stray, { recursive: true });
    writeFileSync(path.join(stray, 'leftover.txt'), 'x');
    mkdirSync(ghost, { recursive: true });

    await app.close();
    app = buildApp({ dataDir, allowedProtocols: PROTOCOLS, limits: LIMITS });
    await app.ready();

    expect(existsSync(stray)).toBe(false);
    expect(existsSync(path.join(dataDir, 'users', 'sweeper', 'sessions', 'ghost'))).toBe(false);
    expect(existsSync(repoFolder('sweeper', session.id, kept.id))).toBe(true);
    expect((await detail('sweeper', session.id)).repos.map((r) => r.id)).toEqual([kept.id]);
  });
});

describe('GET /api/server', () => {
  it('reports the git version, the limits and how git may reach remotes, and no secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/server' });
    expect(res.statusCode).toBe(200);
    const info = res.json<ServerInfo>();
    expect(info.git.version).toMatch(/^\d+\.\d+/);
    expect(info.limits).toEqual(LIMITS);
    expect(info.access.protocols).toEqual(PROTOCOLS);
    expect(info.access.isInteractive).toBe(false);
    expect(typeof info.access.hasSshAgent).toBe('boolean');
    expect(res.body).not.toMatch(/:\/\/[^/\s"]*@/);
  });
});
