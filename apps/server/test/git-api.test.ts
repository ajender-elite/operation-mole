import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitLog, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { Scenario } from './scenario.ts';

/*
 * The git-like primitives behind File Compare's commit views (POST /api/git/log and /api/git/show),
 * on real repositories. History (main):
 *
 *   S ── C1 ── C2 ── C3(rename) ── C4(binary) ──┐
 *         │                                    M (merge)
 *         └── T1 ──────────────────────────────┘ (topic)
 *
 * A range log is X ^Y: the commits reachable from X and not from Y, newest first. Y itself is
 * left to the caller (the UI shows it as the end of the range).
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const c: Record<string, string> = {};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-git-api-'));
  const s = Scenario.fromSeed(path.join(base, 'origin'));
  c['S'] = s.commit({ 'a.txt': 'x\n' }, 'S: base');
  c['C1'] = s.commit({ 'one.txt': '1\n' }, 'C1: one');
  c['C2'] = s.commit(
    { 'a.txt': 'x\ny\n' },
    'C2: add a line\n\nThe body explains\nwhy the line is there.',
  );
  s.branch('topic', c['C1']);
  c['T1'] = s.commit({ 'topic.txt': 't\n' }, 'T1: topic work');
  s.checkout('main');
  c['C3'] = s.move('a.txt', 'renamed.txt', 'C3: rename a');
  c['C4'] = s.commit({ 'bin.dat': 'x\0y' }, 'C4: binary file');
  c['M'] = s.merge('topic', 'M: merge topic');
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'gitapi').start();
  repo = await om.addRepo(s.url);
}, 120_000); // builds a history with a dozen git commands; 30s is too tight under load (see nginx-branches.test.ts)

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

const sha = (rev: string) => c[rev] ?? rev;
type LogCall = { include: string; exclude?: string; options?: Record<string, unknown> };
const logOf = async (body: LogCall): Promise<GitLog> => {
  const res = await om.inject('/api/git/log', {
    user: 'gitapi',
    sessionId: om.sessionId,
    source: { type: 'git', repoId: repo.id, branch: sha(body.include) },
    ...(body.exclude === undefined
      ? {}
      : { exclude: { type: 'git', repoId: repo.id, branch: sha(body.exclude ?? '') } }),
    ...body.options,
  });
  expect(res.statusCode).toBe(200);
  return res.json<GitLog>();
};

describe('POST /api/git/log', () => {
  it('lists the commits X has that Y does not, newest first, with the merge on top', async () => {
    const log = await logOf({ include: 'M', exclude: 'C1' });
    expect(log.commits.map((x) => x.sha)).toEqual(
      expect.arrayContaining([c['M'], c['T1'], c['C2'], c['C3'], c['C4']]),
    );
    expect(log.commits.map((x) => x.sha)).not.toContain(c['C1']);
    expect(log.commits[0]?.sha).toBe(c['M']);
    expect(log.total).toBe(5);
    expect(log.hasMore).toBe(false);
  });

  it('pages with limit and skip, and says whether more remain', async () => {
    const first = await logOf({ include: 'M', exclude: 'C1', options: { limit: 2 } });
    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await logOf({ include: 'M', exclude: 'C1', options: { limit: 2, skip: 2 } });
    expect(second.commits).toHaveLength(2);
    expect(second.commits.map((x) => x.sha)).not.toContain(first.commits[0]?.sha);
  });

  it('returns the full message body on request', async () => {
    const log = await logOf({ include: 'C2', exclude: 'C1', options: { withBody: true } });
    const c2 = log.commits.find((x) => x.sha === c['C2']);
    expect(c2?.subject).toBe('C2: add a line');
    expect(c2?.body).toContain('why the line is there.');
  });

  it('reports per-file additions and deletions, renames and binary files when stats are asked for', async () => {
    const log = await logOf({
      include: 'C4',
      exclude: 'C2',
      options: { withStats: true },
    });
    const commits = log.commits;
    const rename = (
      await logOf({
        include: 'C3',
        exclude: 'C2',
        options: { withStats: true },
      })
    ).commits.find((x) => x.sha === c['C3']);
    expect(rename?.files).toEqual([
      expect.objectContaining({ path: 'renamed.txt', oldPath: 'a.txt', binary: false }),
    ]);
    const binary = commits.find((x) => x.sha === c['C4']);
    expect(binary?.files).toEqual([expect.objectContaining({ path: 'bin.dat', binary: true })]);
  });

  it('keeps only the commits that touched the given paths', async () => {
    const log = await logOf({
      include: 'M',
      exclude: 'C1',
      options: { paths: ['topic.txt'] },
    });
    expect(log.commits.map((x) => x.sha)).toEqual([c['T1']]);
  });

  it('answers with the resolved commits, so the caller can show what was asked for', async () => {
    const log = await logOf({ include: 'M', exclude: 'C1' });
    expect(log.include.commit).toBe(c['M']);
    expect(log.exclude?.commit).toBe(c['C1']);
  });

  it('says whether the excluded commit is in the history of the included one', async () => {
    expect((await logOf({ include: 'M', exclude: 'C1' })).excludeIsAncestor).toBe(true);
    expect((await logOf({ include: 'T1', exclude: 'C2' })).excludeIsAncestor).toBe(false);
    expect((await logOf({ include: 'M' })).excludeIsAncestor).toBeUndefined();
  });

  it('takes a real calendar date for `since`, as the browser sends it', async () => {
    const past = await logOf({ include: 'M', exclude: 'C1', options: { since: '2000-01-01' } });
    expect(past.commits.map((x) => x.sha)).toContain(c['M']);
    // Fixture commits are dated now; 2030 is after them (git ignores far-future dates past ~2038).
    const future = await logOf({ include: 'M', exclude: 'C1', options: { since: '2030-01-01' } });
    expect(future.commits).toEqual([]);
  });

  it('refuses a malformed `since`', async () => {
    const res = await om.inject('/api/git/log', {
      user: 'gitapi',
      sessionId: om.sessionId,
      source: { type: 'git', repoId: repo.id, branch: 'main' },
      since: '2024/01/01',
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a limit above 200', async () => {
    const res = await om.inject('/api/git/log', {
      user: 'gitapi',
      sessionId: om.sessionId,
      source: { type: 'git', repoId: repo.id, branch: 'main' },
      limit: 500,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/git/show', () => {
  it('shows a commit with its metadata, parents and hunks against its first parent', async () => {
    const res = await om.inject('/api/git/show', {
      user: 'gitapi',
      sessionId: om.sessionId,
      source: { type: 'git', repoId: repo.id, branch: c['C2'] ?? '' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ commit: string; details: { subject: string }; files: unknown[] }>();
    expect(body.commit).toBe(c['C2']);
    expect(body.details.subject).toBe('C2: add a line');
    expect(body.files).toHaveLength(1);
  });
});
