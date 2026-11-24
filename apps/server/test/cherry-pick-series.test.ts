import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitCherryPick, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { Scenario } from './scenario.ts';

/*
 * Would `git cherry-pick U1 U2 …` onto a branch succeed, applied in order? Two remotes:
 *
 *   origin    main:    A  (lib.c: one/two/three; clash.txt: base)
 *             stable:  A ── S                    (S: clash.txt = "stable side")
 *             merged:  S ── MG (merge of side)   (side: A ── X, X adds side.txt)
 *   upstream  up:      A ── U1 ── U2 ── U3 ── U4
 *               U1: lib.c "two" -> "TWO"            (applies to stable)
 *               U2: lib.c "three" -> "THREE"        (needs U1: alone it conflicts with U1's neighbour)
 *               U3: clash.txt "base" -> "upstream"  (conflicts with stable's S)
 *               U4: adds new.txt                    (never reached after U3 conflicts)
 *             picked:  S ── P1 (U1 cherry-picked here, so U1 changes nothing on it)
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const c: Record<string, string> = {};
const sha = (name: string): string => c[name] ?? '';

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-series-'));
  const origin = Scenario.fromSeed(path.join(base, 'origin'));
  c['A'] = origin.commit({ 'lib.c': 'one\ntwo\nthree\n', 'clash.txt': 'base\n' }, 'A: base');
  origin.branch('stable', c['A']);
  origin.checkout('stable');
  c['S'] = origin.commit({ 'clash.txt': 'stable side\n' }, 'S: stable changes clash');
  origin.checkout('main');
  origin.branch('side', c['A']);
  origin.checkout('side');
  c['X'] = origin.commit({ 'side.txt': 's\n' }, 'X: side file');
  origin.branch('merged', c['S']);
  origin.checkout('merged');
  c['MG'] = origin.merge('side', 'MG: merge side');
  origin.checkout('main');

  const fork = origin.fork(path.join(base, 'fork'));
  fork.branch('up', c['A']);
  fork.checkout('up');
  c['U1'] = fork.commit({ 'lib.c': 'one\nTWO\nthree\n' }, 'U1: upper two');
  c['U2'] = fork.commit({ 'lib.c': 'one\nTWO\nTHREE\n' }, 'U2: upper three');
  c['U3'] = fork.commit({ 'clash.txt': 'upstream side\n' }, 'U3: clash upstream');
  c['U4'] = fork.commit({ 'new.txt': 'n\n' }, 'U4: new file');
  fork.branch('picked', c['S']);
  fork.checkout('picked');
  c['P1'] = fork.cherryPick(c['U1']);
  fork.checkout('main');

  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'series').start();
  repo = await om.addRepo(origin.url);
  await om.addRemote(repo, 'upstream', fork.url);
  c['ROOT'] = origin.git('rev-list', '--max-parents=0', 'HEAD');
  c['TREE'] = origin.git('rev-parse', 'HEAD^{tree}');
}, 180_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

const onto = (branch: string, remote?: string) => ({
  type: 'git',
  repoId: repo.id,
  branch,
  ...(remote === undefined ? {} : { remote }),
});

async function check(branch: string, commits: string[], remote?: string): Promise<GitCherryPick> {
  const res = await om.inject('/api/git/cherry-pick', {
    onto: onto(branch, remote),
    commits,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<GitCherryPick>();
}

describe('POST /api/git/cherry-pick', () => {
  it('applies a series in order: each pick sees the result of the one before', async () => {
    const body = await check('stable', [sha('U1'), sha('U2')]);
    expect(body.outcome).toBe('applies');
    expect(body.stoppedAt).toBeUndefined();
    expect(body.issues).toEqual([]);
    expect(body.steps.map((s) => s.status)).toEqual(['applies', 'applies']);
    expect(body.steps.map((s) => s.commit.sha)).toEqual([c['U1'], c['U2']]);
    expect(body.changedPaths).toEqual(['lib.c']);
  });

  it('says a pick conflicts when its earlier pick is missing (the dependency is real)', async () => {
    const body = await check('stable', [sha('U2')]);
    expect(body.outcome).toBe('conflict');
    expect(body.stoppedAt).toBe(0);
    expect(body.steps[0]?.status).toBe('conflict');
    expect(body.steps[0]?.conflictedPaths).toEqual(['lib.c']);
  });

  it('stops at the first conflict, with the conflicted text, and leaves later picks not run', async () => {
    const body = await check('stable', [sha('U1'), sha('U2'), sha('U3'), sha('U4')]);
    expect(body.outcome).toBe('conflict');
    expect(body.stoppedAt).toBe(2);
    expect(body.steps.map((s) => s.status)).toEqual(['applies', 'applies', 'conflict', 'not-run']);
    const conflict = body.steps[2];
    expect(conflict?.conflictedPaths).toEqual(['clash.txt']);
    expect(conflict?.conflictedFiles[0]?.text).toContain('<<<<<<<');
    expect(conflict?.conflictedFiles[0]?.text).toContain('>>>>>>>');
    // What the run changed before it stopped (not U4's new file).
    expect(body.changedPaths).toEqual(['lib.c']);
  });

  it('reports a commit already in the branch history as in-history, and carries on', async () => {
    const body = await check('stable', [sha('A'), sha('U1')]);
    expect(body.outcome).toBe('applies');
    expect(body.steps.map((s) => s.status)).toEqual(['in-history', 'applies']);
    expect(body.changedPaths).toEqual(['lib.c']);
  });

  it('reports a pick whose change is already present as no-change, and carries on', async () => {
    // `picked` on the upstream remote already has U1's change (as P1), so U1 changes nothing there.
    const body = await check('picked', [sha('U1'), sha('U2')], 'upstream');
    expect(body.steps.map((s) => s.status)).toEqual(['no-change', 'applies']);
    expect(body.outcome).toBe('applies');
    expect(body.changedPaths).toEqual(['lib.c']);
  });

  it('warns when a commit is listed before its own parent, and still checks the series', async () => {
    const body = await check('stable', [sha('U2'), sha('U1')]);
    expect(body.warnings).toEqual([
      expect.objectContaining({ index: 0, kind: 'parent-after-child' }),
    ]);
    expect(body.outcome).toBe('conflict');
  });

  it('refuses the whole request when a commit is missing, and runs no pick', async () => {
    const body = await check('stable', [sha('U1'), '0'.repeat(40)]);
    expect(body.outcome).toBe('invalid');
    expect(body.issues).toEqual([expect.objectContaining({ index: 1, problem: 'not-found' })]);
    expect(body.steps).toEqual([]);
    expect(body.changedPaths).toEqual([]);
  });

  it('refuses a duplicate, a tree named as a commit, a merge, and a root commit', async () => {
    const duplicate = await check('stable', [sha('U1'), sha('U1')]);
    expect(duplicate.issues).toEqual([expect.objectContaining({ index: 1, problem: 'duplicate' })]);

    const tree = await check('stable', [sha('TREE')]);
    expect(tree.issues).toEqual([expect.objectContaining({ index: 0, problem: 'not-a-commit' })]);

    const merge = await check('stable', [sha('MG')]);
    expect(merge.issues).toEqual([expect.objectContaining({ index: 0, problem: 'merge' })]);

    const root = await check('stable', [sha('ROOT')]);
    expect(root.issues).toEqual([expect.objectContaining({ index: 0, problem: 'root' })]);
    for (const body of [duplicate, tree, merge, root]) {
      expect(body.outcome).toBe('invalid');
      expect(body.steps).toEqual([]);
    }
  });

  it('answers 400 for a malformed request', async () => {
    const empty = await om.inject('/api/git/cherry-pick', { onto: onto('stable'), commits: [] });
    expect(empty.statusCode).toBe(400);
    const short = await om.inject('/api/git/cherry-pick', {
      onto: onto('stable'),
      commits: ['abc123'],
    });
    expect(short.statusCode).toBe(400);
  });

  it('writes nothing: no ref moves, and the scratch store is empty afterwards', async () => {
    const before = await om.inject('/api/git/refs', { repoId: repo.id });
    await check('stable', [sha('U1'), sha('U2'), sha('U3')]);
    const after = await om.inject('/api/git/refs', { repoId: repo.id });
    expect(after.json()).toEqual(before.json());
    expect(await readdir(path.join(base, 'data', 'scratch'))).toEqual([]);
  });

  it('serves a repeated check from the cache, with the same answer', async () => {
    const first = await check('stable', [sha('U1'), sha('U2')]);
    const second = await check('stable', [sha('U1'), sha('U2')]);
    expect(second).toEqual(first);
  });
});
