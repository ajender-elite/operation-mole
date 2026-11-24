import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitLog, GitPatchEquivalents, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { BOB, Scenario } from './scenario.ts';
import { OmClient } from './om-client.ts';

/*
 * Searching a log (message, author, one file through its renames) and comparing two sides with
 * their messages. History (main):
 *
 *   S ── C1 ── C2(body) ── C3(rename a.txt → renamed.txt) ── C4 ── M
 *         └── T1 (by Bob) ───────────────────────────────────────┘
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const c: Record<string, string> = {};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-log-search-'));
  const s = Scenario.fromSeed(path.join(base, 'origin'));
  c['S'] = s.commit({ 'a.txt': 'x\n' }, 'S: base');
  c['C1'] = s.commit({ 'one.txt': '1\n' }, 'C1: one');
  c['C2'] = s.commit(
    { 'a.txt': 'x\ny\n' },
    'C2: add a line\n\nThe body explains\nwhy the line is there.',
  );
  s.branch('topic', c['C1']);
  c['T1'] = s.commit({ 'topic.txt': 't\n' }, 'T1: topic work', { author: BOB });
  s.checkout('main');
  c['C3'] = s.move('a.txt', 'renamed.txt', 'C3: rename a');
  c['C4'] = s.commit({ 'bin.dat': 'x\0y' }, 'C4: binary file');
  c['M'] = s.merge('topic', 'M: merge topic');
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'logsearch').start();
  repo = await om.addRepo(s.url);
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

const src = (rev: string) => ({ type: 'git', repoId: repo.id, branch: c[rev] ?? rev });
const shas = (log: GitLog) => log.commits.map((x) => x.sha);

async function logOf(include: string, options: Record<string, unknown>): Promise<GitLog> {
  const res = await om.inject('/api/git/log', { source: src(include), ...options });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<GitLog>();
}

describe('POST /api/git/log with a search', () => {
  it('finds the commits whose message contains the text, ignoring case', async () => {
    const log = await logOf('M', { grep: 'WHY THE LINE' });
    expect(shas(log)).toEqual([c['C2']]);
    expect(log.total).toBe(1);
  });

  it('finds the commits by author name, ignoring case', async () => {
    const log = await logOf('M', { author: 'bob downstream' });
    expect(shas(log)).toEqual([c['T1']]);
    expect(log.total).toBe(1);
  });

  it('combines the search with a range', async () => {
    const log = await logOf('M', { exclude: src('C2'), grep: 'C' });
    expect(shas(log)).not.toContain(c['C2']);
    expect(shas(log)).toContain(c['C3']);
  });

  it('follows one file through its renames, when asked', async () => {
    const plain = await logOf('M', { paths: ['renamed.txt'] });
    expect(shas(plain)).toEqual([c['C3']]);
    const followed = await logOf('M', { paths: ['renamed.txt'], follow: true });
    expect(shas(followed)).toEqual([c['C3'], c['C2'], c['S']]);
    expect(followed.total).toBe(3);
    expect(followed.hasMore).toBe(false);
  });

  it('refuses to follow more than one path', async () => {
    const res = await om.inject('/api/git/log', {
      source: src('M'),
      paths: ['renamed.txt', 'a.txt'],
      follow: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists the same commits in topological order', async () => {
    const plain = await logOf('M', {});
    const topo = await logOf('M', { topoOrder: true });
    expect([...shas(topo)].sort()).toEqual([...shas(plain)].sort());
    expect(topo.total).toBe(plain.total);
  });
});

describe('POST /api/git/patch-equivalents with messages and a limit', () => {
  it('carries each commit message when asked, for matching trailers', async () => {
    const res = await om.inject('/api/git/patch-equivalents', {
      left: src('M'),
      right: src('T1'),
      withBody: true,
    });
    const body = res.json<GitPatchEquivalents>();
    const c2 = body.commits.find((x) => x.commit.sha === c['C2']);
    expect(c2?.commit.body).toContain('why the line is there.');
    expect(body.commits.every((x) => x.commit.body !== undefined)).toBe(true);
  });

  it('leaves messages out by default, and says when the limit cut the list', async () => {
    const full = (
      await om.inject('/api/git/patch-equivalents', { left: src('M'), right: src('T1') })
    ).json<GitPatchEquivalents>();
    expect(full.commits.some((x) => x.commit.body !== undefined)).toBe(false);
    expect(full.truncated).toBeUndefined();
    expect(full.commits.length).toBeGreaterThan(2);

    const limited = (
      await om.inject('/api/git/patch-equivalents', {
        left: src('M'),
        right: src('T1'),
        limit: 2,
      })
    ).json<GitPatchEquivalents>();
    expect(limited.commits).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });
});
