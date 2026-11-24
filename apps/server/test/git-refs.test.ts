import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitContains, GitPatchIds, GitRefs, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { hasAheadBehind } from '../src/git-api/refs.ts';
import { OmClient } from './om-client.ts';
import { Scenario } from './scenario.ts';

/*
 * Two remotes of one repo, as OM holds them: `origin` and `upstream` (a fork).
 *
 *   origin  main:   A ── B ── M (merge of stable)           tags: v1 on S
 *           stable: A ── S ── P (P: B cherry-picked here)
 *   upstream main:  (the same as origin's main)  ── D1 on dev only
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const c: Record<string, string> = {};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-refs-'));
  const origin = Scenario.fromSeed(path.join(base, 'origin'));
  c['A'] = origin.commit({ 'a.txt': 'a\n' }, 'A: base');
  c['B'] = origin.commit({ 'b.txt': 'b\n' }, 'B: on main');
  origin.branch('stable', sha('A'));
  origin.checkout('stable');
  c['S'] = origin.commit({ 's.txt': 's\n' }, 'S: on stable');
  origin.tag('v1', sha('S'));
  c['P'] = origin.cherryPick(sha('B'));
  origin.checkout('main');
  c['M'] = origin.merge('stable', 'M: merge stable');

  const fork = origin.fork(path.join(base, 'fork'));
  fork.branch('dev', 'main');
  c['D1'] = fork.commit({ 'd.txt': 'd\n' }, 'D1: dev only');

  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'refs').start();
  repo = await om.addRepo(origin.url);
  await om.addRemote(repo, 'upstream', fork.url);
}, 180_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

const src = (branch: string, remote?: string) => ({
  type: 'git',
  repoId: repo.id,
  branch,
  ...(remote === undefined ? {} : { remote }),
});
const sha = (name: string): string => c[name] ?? '';
const key = (r: { remote: string; kind: string; name: string }) =>
  `${r.remote}/${r.kind}/${r.name}`;

describe('POST /api/git/refs', () => {
  it('lists the branches and tags of every remote, origin first', async () => {
    const res = await om.inject('/api/git/refs', { repoId: repo.id });
    expect(res.statusCode).toBe(200);
    const body = res.json<GitRefs>();
    // `seed` is the Hello-World seed's own branch; the fork inherits origin's tag.
    expect(body.refs.map(key)).toEqual([
      'origin/branch/main',
      'origin/branch/seed',
      'origin/branch/stable',
      'origin/tag/v1',
      'upstream/branch/dev',
      'upstream/branch/main',
      'upstream/tag/v1',
    ]);
    const main = body.refs.find((r) => r.remote === 'origin' && r.name === 'main');
    expect(main?.commit).toBe(sha('M'));
    expect(main?.subject).toBe('M: merge stable');
    expect(main?.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(main?.ahead).toBeUndefined();
  });

  it('counts how far each branch is ahead of and behind the commit it is compared to', async () => {
    const res = await om.inject('/api/git/refs', {
      repoId: repo.id,
      compareTo: src('main'),
    });
    const body = res.json<GitRefs>();
    expect(body.compareTo?.commit).toBe(sha('M'));
    const stable = body.refs.find((r) => r.remote === 'origin' && r.name === 'stable');
    // Main (M) has everything stable has, and two more: B and M itself.
    expect(stable).toMatchObject({ ahead: 0, behind: 2 });
    const dev = body.refs.find((r) => r.remote === 'upstream' && r.name === 'dev');
    expect(dev).toMatchObject({ ahead: 1, behind: 0 });
  });

  it('answers 404 for a repo that is not in the session', async () => {
    const res = await om.inject('/api/git/refs', { repoId: 'nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/git/contains', () => {
  it('lists every branch and tag, of any remote, whose history holds the commit', async () => {
    const atB = await om.inject('/api/git/contains', {
      source: { type: 'git', repoId: repo.id, branch: sha('B') },
    });
    expect(atB.json<GitContains>().refs.map(key)).toEqual([
      'origin/branch/main',
      'upstream/branch/dev',
      'upstream/branch/main',
    ]);
  });

  it('gives only the refs that contain a commit on one branch', async () => {
    const atD1 = await om.inject('/api/git/contains', {
      source: { type: 'git', repoId: repo.id, branch: sha('D1') },
    });
    expect(atD1.json<GitContains>().refs.map(key)).toEqual(['upstream/branch/dev']);
  });

  it('includes a tag that points at a commit', async () => {
    const atS = await om.inject('/api/git/contains', {
      source: { type: 'git', repoId: repo.id, branch: sha('S') },
    });
    expect(atS.json<GitContains>().refs.map(key)).toEqual([
      'origin/branch/main',
      'origin/branch/stable',
      'origin/tag/v1',
      'upstream/branch/dev',
      'upstream/branch/main',
      'upstream/tag/v1',
    ]);
  });
});

describe('POST /api/git/patch-ids', () => {
  it('gives a commit and its cherry-pick the same patch id, and a merge none', async () => {
    const res = await om.inject('/api/git/patch-ids', {
      source: { type: 'git', repoId: repo.id, branch: sha('B') },
      commits: [sha('B'), sha('P'), sha('M'), sha('D1')],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<GitPatchIds>();
    const id = (commit: string) => body.results.find((r) => r.commit === commit)?.patchId;
    expect(id(sha('B'))).toMatch(/^[0-9a-f]{40}$/);
    expect(id(sha('P'))).toBe(id(sha('B')));
    expect(id(sha('M'))).toBeNull();
    expect(id(sha('D1'))).not.toBe(id(sha('B')));
  });

  it('answers 404 for a commit the repo does not have', async () => {
    const res = await om.inject('/api/git/patch-ids', {
      source: { type: 'git', repoId: repo.id, branch: sha('B') },
      commits: ['0'.repeat(40)],
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('hasAheadBehind', () => {
  it('needs git 2.41 or later, whatever the platform suffix', () => {
    expect(hasAheadBehind('2.47.0.windows.2')).toBe(true);
    expect(hasAheadBehind('2.41.0')).toBe(true);
    expect(hasAheadBehind('2.40.1')).toBe(false);
    expect(hasAheadBehind('3.0.0')).toBe(true);
    expect(hasAheadBehind('nonsense')).toBe(false);
  });
});
