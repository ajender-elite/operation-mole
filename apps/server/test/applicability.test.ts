import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApplicabilityResult, GitSource, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { GitService } from '../src/git/git-service.ts';
import type { ResolvedSnapshot } from '../src/git/repo-manager.ts';
import { SnapshotAnalyzer } from '../src/snapshot/snapshot-analyzer.ts';
import { UpstreamAnalyzer } from '../src/upstream/upstream-analyzer.ts';
import { OmClient } from './om-client.ts';
import { BOB, SEED_COMMIT, SEED_FIRST, Scenario, repoState } from './scenario.ts';

/*
 * Commit applicability (upstream = Base, downstream = Target) against real git.
 *
 *   S ─ U0 ─ U1 ─ U2 ─ U3 ─ U4 ─ U5 ─ U6a ─ U6b ─ U7 ─ U8 ─ U9 ─ M ──[up]
 *   │    │                                                     ╱
 *   │    │                                             T1 ────╯ (topic)
 *   └────┴ D0(merge U0) ─ D1 ─ D2 ─ D3 ─ D4 ─ D5 ─ D6 ─ D7 ─ D8 ──[down]
 *
 *   U0  early.txt                 → reachable from downstream (merged by D0)
 *   U1  adds feature.txt          → clean
 *   U2  shared.txt line 2         → conflict with D1 (same line)
 *   U3  adds util.txt             → cherry-picked as D2 → equivalent patch
 *   U4  config a=9                → D3 makes the same edit inside a bigger commit → no effective change
 *   U5  edits feature.txt (U1's)  → conflict alone (independent), clean after U1 (sequential)
 *   U6a/U6b two edits to sq.txt   → squashed downstream as D4 → U6a has no effective change
 *   U7  edits p1.txt and p2.txt   → D5 already has the p1 edit → clean, partially represented
 *   U8  v=1 → v=2                 → cherry-picked (D6) then evolved to v=3 (D7) → conflict + equivalent
 *   U9  adds reb.txt              → rebased copy downstream (D8: new parent, new committer)
 *   M   merges topic T1           → merge commit, evaluated against its first parent
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
let s: Scenario;
const c: Record<string, string> = {};
const SQ = (first: string, last: string) => `${first}\n2\n3\n4\n5\n6\n7\n${last}\n`;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-apply-'));
  s = Scenario.fromSeed(path.join(base, 'origin'));
  c['S'] = s.commit(
    {
      'shared.txt': '1\n2\n3\n4\n5\n',
      'config.txt': 'a=1\nb=2\n',
      'sq.txt': SQ('1', '8'),
      'p1.txt': 'p\n',
      'p2.txt': 'q\n',
      'evolve.txt': 'v=1\n',
    },
    'S: shared base',
  );
  s.branch('up');
  c['U0'] = s.commit({ 'early.txt': 'early\n' }, 'U0: early');
  c['U1'] = s.commit({ 'feature.txt': 'feature v1\n' }, 'U1: add feature');
  c['U2'] = s.commit({ 'shared.txt': '1\n2-up\n3\n4\n5\n' }, 'U2: upstream line 2');
  c['U3'] = s.commit({ 'util.txt': 'util\n' }, 'U3: add util');
  c['U4'] = s.commit({ 'config.txt': 'a=9\nb=2\n' }, 'U4: a=9');
  c['U5'] = s.commit({ 'feature.txt': 'feature v2\n' }, 'U5: improve feature');
  c['U6a'] = s.commit({ 'sq.txt': SQ('ONE', '8') }, 'U6a: first line');
  c['U6b'] = s.commit({ 'sq.txt': SQ('ONE', 'EIGHT') }, 'U6b: last line');
  c['U7'] = s.commit({ 'p1.txt': 'p!\n', 'p2.txt': 'q!\n' }, 'U7: p1 and p2');
  c['U8'] = s.commit({ 'evolve.txt': 'v=2\n' }, 'U8: v=2');
  c['U9'] = s.commit({ 'reb.txt': 'rebased\n' }, 'U9: add reb');
  s.branch('topic', c['U9']);
  c['T1'] = s.commit({ 'merged.txt': 'from topic\n' }, 'T1: topic work');
  s.checkout('up');
  c['M'] = s.merge('topic', 'M: merge topic');

  s.branch('down', c['S']);
  c['D0'] = s.merge(c['U0'] ?? '', 'D0: merge U0', BOB);
  c['D1'] = s.commit({ 'shared.txt': '1\n2-down\n3\n4\n5\n' }, 'D1: downstream line 2', {
    author: BOB,
  });
  c['D2'] = s.cherryPick(c['U3'] ?? '');
  c['D3'] = s.commit({ 'config.txt': 'a=9\nb=2\n', 'zzz.txt': 'z\n' }, 'D3: config and more', {
    author: BOB,
  });
  c['D4'] = s.commit({ 'sq.txt': SQ('ONE', 'EIGHT') }, 'D4: squash of U6a+U6b', { author: BOB });
  c['D5'] = s.commit({ 'p1.txt': 'p!\n' }, 'D5: p1 only', { author: BOB });
  c['D6'] = s.cherryPick(c['U8'] ?? '');
  c['D7'] = s.commit({ 'evolve.txt': 'v=3\n' }, 'D7: evolve v', { author: BOB });
  c['D8'] = s.cherryPick(c['U9'] ?? '', { name: 'Rebaser', email: 'rebase@example.com' });

  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'apply').start();
  repo = await om.addRepo(s.url);
}, 120_000); // builds a full history with many git processes; the 30s default is too tight under load
afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const up = (): GitSource => om.source(repo, 'up');
const down = (): GitSource => om.source(repo, 'down');
const apply = (name: string): Promise<ApplicabilityResult> =>
  om.applicability({ upstream: up(), downstream: down(), commit: c[name] ?? name });

describe('the upstream commit window', () => {
  it('lists the newest upstream commits with git metadata and reachability', async () => {
    const list = await om.commits({ upstream: up(), downstream: down(), limit: 5 });
    expect(list.upstream.commit).toBe(s.rev('up'));
    expect(list.downstream.commit).toBe(s.rev('down'));
    expect(list.commits).toHaveLength(5);
    expect(list.hasMore).toBe(true);
    const merge = list.commits[0];
    expect(merge).toMatchObject({
      sha: c['M'],
      subject: 'M: merge topic',
      parents: [c['U9'], c['T1']],
    });
    expect(merge?.commitDate).toMatch(/^2026-/);
    expect(list.commits.every((x) => !x.reachableFromDownstream)).toBe(true);
  });

  it('marks commits downstream already contains, or hides them', async () => {
    const all = await om.commits({ upstream: up(), downstream: down(), limit: 200 });
    const reachable = all.commits.filter((x) => x.reachableFromDownstream).map((x) => x.sha);
    expect(reachable).toContain(c['U0']);
    expect(reachable).toContain(c['S']);
    expect(reachable).toContain(SEED_COMMIT);
    expect(reachable).not.toContain(c['U3']); // cherry-picked: same patch, different commit
    const hidden = await om.commits({
      upstream: up(),
      downstream: down(),
      limit: 200,
      hideReachable: true,
    });
    expect(hidden.commits.map((x) => x.sha)).not.toContain(c['U0']);
    expect(hidden.commits.map((x) => x.sha)).toContain(c['U3']);
    expect(hidden.hasMore).toBe(false);
  });

  it('follows first parents only when asked', async () => {
    const all = await om.commits({
      upstream: up(),
      downstream: down(),
      limit: 200,
      hideReachable: true,
    });
    expect(all.commits.map((x) => x.sha)).toContain(c['T1']);
    const mainline = await om.commits({
      upstream: up(),
      downstream: down(),
      limit: 200,
      hideReachable: true,
      firstParent: true,
    });
    expect(mainline.commits.map((x) => x.sha)).not.toContain(c['T1']);
  });

  it('lists only the commits that touched the given paths, when given any', async () => {
    // U1 adds feature.txt and U5 edits it; U3 only touches util.txt.
    const touching = await om.commits({
      upstream: up(),
      downstream: down(),
      limit: 200,
      hideReachable: true,
      paths: ['feature.txt'],
    });
    const shas = touching.commits.map((x) => x.sha);
    expect(shas).toContain(c['U1']);
    expect(shas).toContain(c['U5']);
    expect(shas).not.toContain(c['U3']);
    expect(touching.hasMore).toBe(false);

    // Several paths: the commits that touched any of them (U3 touches util.txt).
    const either = await om.commits({
      upstream: up(),
      downstream: down(),
      limit: 200,
      hideReachable: true,
      paths: ['feature.txt', 'util.txt'],
    });
    expect(either.commits.map((x) => x.sha)).toEqual(
      expect.arrayContaining([c['U1'], c['U3'], c['U5']]),
    );
  });

  it('filters by commit date', async () => {
    // The scenario's commits are dated 2026; the pinned seed's are from 2011 and 2012.
    const list = await om.commits({
      upstream: up(),
      downstream: down(),
      limit: 200,
      since: '2026-01-01',
    });
    expect(list.commits.length).toBeGreaterThan(0);
    expect(list.commits.every((x) => x.commitDate >= '2026-01-01')).toBe(true);
    expect(list.commits.map((x) => x.sha)).not.toContain(SEED_COMMIT);
    const none = await om.commits({
      upstream: up(),
      downstream: down(),
      limit: 200,
      since: '2030-01-01',
    });
    expect(none.commits).toEqual([]);
  });
});

describe('applicability states', () => {
  it('clean apply: applies without conflict and changes downstream', async () => {
    const r = await apply('U1');
    expect(r).toMatchObject({
      status: 'clean',
      reason: 'applies',
      isMerge: false,
      baseParent: c['U0'],
    });
    expect(r.files).toEqual([{ path: 'feature.txt', outcome: 'applies' }]);
    expect(r.downstreamCommit).toBe(s.rev('down'));
  });

  it('already represented: the exact commit is reachable', async () => {
    const r = await apply('U0');
    expect(r).toMatchObject({ status: 'represented', reason: 'reachable' });
    expect(r.files).toEqual([{ path: 'early.txt', outcome: 'already-present' }]);
  });

  it('already represented: a cherry-pick with another SHA (not SHA equality)', async () => {
    const r = await apply('U3');
    expect(r).toMatchObject({ status: 'represented', reason: 'equivalent-patch' });
    expect(r.equivalentCommits.map((x) => x.sha)).toEqual([c['D2']]);
    expect(c['D2']).not.toBe(c['U3']);
  });

  it('already represented: a rebased copy (new parent and committer)', async () => {
    const r = await apply('U9');
    expect(r).toMatchObject({ status: 'represented', reason: 'equivalent-patch' });
    expect(r.equivalentCommits[0]).toMatchObject({ sha: c['D8'], committerName: 'Rebaser' });
  });

  it('already represented: equivalent content inside an unrelated commit', async () => {
    const r = await apply('U4');
    expect(r).toMatchObject({ status: 'represented', reason: 'no-effective-change' });
    expect(r.equivalentCommits).toEqual([]);
    expect(r.files).toEqual([{ path: 'config.txt', outcome: 'already-present' }]);
  });

  it('already represented: one of the commits squashed downstream', async () => {
    const r = await apply('U6a');
    expect(r).toMatchObject({ status: 'represented', reason: 'no-effective-change' });
  });

  it('clean apply that is partially represented', async () => {
    const r = await apply('U7');
    expect(r.status).toBe('clean');
    expect(r.files).toEqual([
      { path: 'p1.txt', outcome: 'already-present' },
      { path: 'p2.txt', outcome: 'applies' },
    ]);
  });

  it('conflicting apply, with the conflict as evidence', async () => {
    const r = await apply('U2');
    expect(r).toMatchObject({ status: 'conflict', reason: 'conflict' });
    expect(r.files).toEqual([{ path: 'shared.txt', outcome: 'conflict' }]);
    expect(r.messages.join('\n')).toMatch(/CONFLICT \(content\).*shared\.txt/);
    const excerpt = r.conflicts[0];
    expect(excerpt?.path).toBe('shared.txt');
    expect(excerpt?.lines.join('\n')).toMatch(/<<<<<<<[^\n]*\n2-down\n=======\n2-up\n>>>>>>>/);
    expect(r.equivalentCommits).toEqual([]);
  });

  it('conflict against evolved downstream content does not claim the change is absent', async () => {
    const r = await apply('U8');
    expect(r.status).toBe('conflict');
    expect(r.equivalentCommits.map((x) => x.sha)).toEqual([c['D6']]);
    expect(r.detail).toMatch(/same patch-id/);
  });

  it('merge commit: evaluated against its first parent', async () => {
    const r = await apply('M');
    expect(r).toMatchObject({ status: 'clean', isMerge: true, baseParent: c['U9'] });
    expect(r.files).toEqual([{ path: 'merged.txt', outcome: 'applies' }]);
    expect(r.detail).toMatch(/first parent/);
  });

  it('root and merge commits of the pinned seed are reachable', async () => {
    expect(await apply(SEED_FIRST)).toMatchObject({ status: 'represented', reason: 'reachable' });
    expect(await apply(SEED_COMMIT)).toMatchObject({ status: 'represented', isMerge: true });
  });

  it('404 for a commit that does not exist upstream', async () => {
    const res = await om.inject('/api/upstream/applicability', {
      upstream: up(),
      downstream: down(),
      commit: 'f'.repeat(40),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('independent applicability', () => {
  it('evaluates every commit against the same pristine downstream snapshot', async () => {
    const results = await Promise.all(['U1', 'U5', 'U2', 'U7'].map(apply));
    expect(new Set(results.map((r) => r.downstreamCommit))).toEqual(new Set([s.rev('down')]));
    // U5 edits a file U1 creates: alone it conflicts (modify/delete)…
    expect(results[1]).toMatchObject({ status: 'conflict' });
    expect(results[1]?.messages.join('\n')).toMatch(/modify\/delete/);
    // …whereas applying the series (U1, then U5) would succeed: a different question.
    const series = path.join(base, 'series');
    execFileSync('git', ['clone', '-q', '--no-local', '-b', 'down', s.dir, series]);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    execFileSync('git', ['cherry-pick', c['U1'] ?? '', c['U5'] ?? ''], {
      cwd: series,
      env,
      stdio: 'ignore',
    });
  });

  it('gives the same answer whatever order commits are evaluated in', async () => {
    const first = await apply('U5');
    await apply('U1');
    expect(await apply('U5')).toEqual(first);
  });
});

describe('patches', () => {
  it('returns a commit’s files and hunks against its first parent', async () => {
    const patch = await om.patch(up(), c['U2'] ?? '');
    expect(patch.baseParent).toBe(c['U1']);
    expect(patch.files).toHaveLength(1);
    expect(patch.files[0]).toMatchObject({
      oldPath: 'shared.txt',
      newPath: 'shared.txt',
      status: 'modified',
    });
    expect(
      patch.files[0]?.hunks[0]?.lines.filter((l) => l.kind !== 'context').map((l) => l.text),
    ).toEqual(['2', '2-up']);
  });

  it('labels added files and merges', async () => {
    const merge = await om.patch(up(), c['M'] ?? '');
    expect(merge.files).toEqual([
      expect.objectContaining({ newPath: 'merged.txt', status: 'added', binary: false }),
    ]);
  });

  it('returns the commit itself, with its git metadata and parents', async () => {
    const merge = await om.patch(up(), c['M'] ?? '');
    expect(merge.details).toMatchObject({
      sha: c['M'],
      subject: 'M: merge topic',
      parents: [c['U9'], c['T1']],
    });
    expect(merge.details.commitDate).toMatch(/^2026-/);
  });
});

/* ── Safety ─────────────────────────────────────────────────────────────────────────── */

describe('repository safety', () => {
  const omRepoDir = () =>
    path.join(base, 'data', 'users', 'apply', 'sessions', om.sessionId, 'repos', repo.id);
  const downWorktree = () =>
    path.join(
      base,
      'data',
      'users',
      'apply',
      'sessions',
      om.sessionId,
      'worktrees',
      repo.id,
      'down',
    );
  const scratch = () => path.join(base, 'data', 'scratch');
  const scratchEntries = () => (existsSync(scratch()) ? readdirSync(scratch()) : []);

  it.each(['U1', 'U3', 'U2'])(
    'leaves OM’s clone, the downstream checkout and the origin unchanged (%s)',
    async (name) => {
      await apply('U0'); // creates the downstream worktree first
      const before = [
        repoState(omRepoDir(), downWorktree()),
        repoState(path.join(s.dir, '.git'), s.dir),
      ];
      const r = await om.applicability({
        upstream: up(),
        downstream: down(),
        commit: c[name] ?? '',
      });
      expect(['clean', 'represented', 'conflict']).toContain(r.status);
      expect([
        repoState(omRepoDir(), downWorktree()),
        repoState(path.join(s.dir, '.git'), s.dir),
      ]).toEqual(before);
      expect(scratchEntries()).toEqual([]);
    },
  );

  // Direct use of the analyzer on a developer-style working repository (non-bare, checked out).
  const working = (): { git: GitService; snapshot: (ref: string) => ResolvedSnapshot } => {
    const git = new GitService();
    const gitDir = path.join(s.dir, '.git');
    return {
      git,
      snapshot: (ref) => ({ repoDir: gitDir, commit: s.rev(ref), ref, label: ref }),
    };
  };

  it.each(['U1', 'U3', 'U2', 'U8'])(
    'works on a working repository without touching it (%s)',
    async (name) => {
      const { git, snapshot } = working();
      const scratchDir = path.join(base, 'scratch-working');
      const analyzer = new UpstreamAnalyzer(
        git,
        new SnapshotAnalyzer(git, { maxTextBytes: 1e6, maxDiffLines: 1e4 }),
        {
          scratchDir,
        },
      );
      s.checkout('down');
      const before = repoState(path.join(s.dir, '.git'), s.dir);
      await analyzer.applicability(snapshot('up'), snapshot('down'), c[name] ?? '');
      expect(repoState(path.join(s.dir, '.git'), s.dir)).toBe(before);
      expect(readdirSync(scratchDir)).toEqual([]);
    },
  );

  it('reports a failed analysis as unknown and still cleans up', async () => {
    const blocked = path.join(base, 'not-a-dir');
    writeFileSync(blocked, 'x');
    const { git, snapshot } = working();
    const analyzer = new UpstreamAnalyzer(
      git,
      new SnapshotAnalyzer(git, { maxTextBytes: 1e6, maxDiffLines: 1e4 }),
      {
        scratchDir: path.join(blocked, 'scratch'),
      },
    );
    const before = repoState(path.join(s.dir, '.git'), s.dir);
    const r = await analyzer.applicability(snapshot('up'), snapshot('down'), c['U1'] ?? '');
    expect(r).toMatchObject({ status: 'unknown', reason: 'error' });
    expect(r.detail).toBeTruthy();
    expect(repoState(path.join(s.dir, '.git'), s.dir)).toBe(before);
  });

  it.each([0, 1, 5, 20])('cancels and cleans up (abort after %i ms)', async (delayMs) => {
    const { git, snapshot } = working();
    const scratchDir = path.join(base, `scratch-cancel-${delayMs}`);
    const analyzer = new UpstreamAnalyzer(
      git,
      new SnapshotAnalyzer(git, { maxTextBytes: 1e6, maxDiffLines: 1e4 }),
      {
        scratchDir,
      },
    );
    const before = repoState(path.join(s.dir, '.git'), s.dir);
    const controller = new AbortController();
    if (delayMs === 0) controller.abort();
    else
      setTimeout(() => {
        controller.abort();
      }, delayMs);
    const outcome = await analyzer
      .applicability(snapshot('up'), snapshot('down'), c['U8'] ?? '', controller.signal)
      .then(
        () => 'finished',
        (err: unknown) => (err instanceof Error ? err.name : 'error'),
      );
    expect(['finished', 'AbortError']).toContain(outcome);
    if (delayMs === 0) expect(outcome).toBe('AbortError');
    expect(repoState(path.join(s.dir, '.git'), s.dir)).toBe(before);
    expect(existsSync(scratchDir) ? readdirSync(scratchDir) : []).toEqual([]);
  });
});

describe('conflicts that are not content conflicts', () => {
  it('marks a file conflicting when git names it in a rename/delete conflict', async () => {
    const r = Scenario.fromSeed(path.join(base, 'rename-delete'));
    r.commit({ 'SECURITY.md': 'report issues privately\n'.repeat(5) }, 'base');
    r.branch('upstream');
    const deletion = r.commit({ 'SECURITY.md': null }, 'Use the global security policy');
    r.branch('downstream', 'main');
    r.move('SECURITY.md', 'Security.md', 'Rename security policy');
    const repoInfo = await om.addRepo(r.url);
    const result = await om.applicability({
      upstream: om.source(repoInfo, 'upstream'),
      downstream: om.source(repoInfo, 'downstream'),
      commit: deletion,
    });
    expect(result.status).toBe('conflict');
    expect(result.messages.join('\n')).toMatch(/CONFLICT \(rename\/delete\)/);
    expect(result.files).toEqual([{ path: 'SECURITY.md', outcome: 'conflict' }]);
  });
});
