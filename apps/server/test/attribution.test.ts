import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiffLine, GitSource, RepoInfo, SnapshotFileDiff } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { ALICE, BOB, Scenario } from './scenario.ts';

/*
 * Divergence attribution: which commit currently accounts for each differing line, on that
 * line's own side, at hunk, file and directory scope. History (all from the pinned seed):
 *
 *   base ── A (creates calc.txt with X) ── [blue]
 *             └── B (adds Y after X) ── C (rewrites X) ── D (lib/other.txt) ── [green]
 *   base ── … ── E (blue-only: shared.txt line 2) on [blue]
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
let scenario: Scenario;
const sha: Record<string, string> = {};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-attr-'));
  scenario = Scenario.fromSeed(path.join(base, 'origin'));
  sha['base'] = scenario.commit(
    { 'shared.txt': 'one\ntwo\nthree\n', 'lib/keep.txt': 'keep\n' },
    'Shared base',
  );
  sha['A'] = scenario.commit({ 'lib/calc.txt': 'head\nvalue = 10\ntail\n' }, 'A: introduce value');
  scenario.branch('blue');
  scenario.branch('green');
  sha['B'] = scenario.commit(
    { 'lib/calc.txt': 'head\nvalue = 10\nlimit = 5\ntail\n' },
    'B: add limit',
    { author: BOB },
  );
  sha['C'] = scenario.commit(
    { 'lib/calc.txt': 'head\nvalue = 20\nlimit = 5\ntail\n' },
    'C: change value',
    { author: BOB },
  );
  sha['D'] = scenario.commit({ 'lib/other.txt': 'other\n' }, 'D: other file', { author: BOB });
  // A file whose five lines each come from a different commit (five historical versions).
  for (let i = 1; i <= 5; i++) {
    sha[`H${i}`] = scenario.commit(
      { 'hist/h.txt': Array.from({ length: i }, (_, j) => `line ${j + 1}\n`).join('') },
      `H${i}: line ${i}`,
      { author: BOB },
    );
  }
  scenario.checkout('blue');
  sha['E'] = scenario.commit({ 'shared.txt': 'one\nTWO\nthree\n' }, 'E: blue edits shared', {
    author: ALICE,
  });

  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'attr').start();
  repo = await om.addRepo(scenario.url);
}, 120_000); // builds a full history with many git processes; the 30s default is too tight under load
afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const src = (ref: string): GitSource => om.source(repo, ref);
const changed = (diff: SnapshotFileDiff): DiffLine[] =>
  diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
const commitOf = (diff: SnapshotFileDiff, text: string) =>
  changed(diff).find((l) => l.text === text)?.commit;
const commitSet = (lines: DiffLine[]) => [...new Set(lines.map((l) => l.commit))].sort();

const calc = () =>
  om.fileDiff({
    left: src('blue'),
    right: src('green'),
    leftPath: 'lib/calc.txt',
    rightPath: 'lib/calc.txt',
  });

describe('line attribution', () => {
  it('attributes a line to the commit that currently accounts for it, not the one that introduced it', async () => {
    const diff = await calc();
    // "value = 20" was introduced as "value = 10" by A, but C is what makes it differ now.
    expect(commitOf(diff, 'value = 20')).toBe(sha['C']);
    expect(commitOf(diff, 'limit = 5')).toBe(sha['B']);
  });

  it('attributes removed (Base-only) lines in Base history', async () => {
    const diff = await calc();
    expect(commitOf(diff, 'value = 10')).toBe(sha['A']);
  });

  it('includes commit metadata for every attributed commit', async () => {
    const diff = await calc();
    const c = diff.commits.find((x) => x.sha === sha['C']);
    expect(c).toMatchObject({
      subject: 'C: change value',
      authorName: BOB.name,
      authorEmail: BOB.email,
      committerName: BOB.name,
    });
    expect(c?.authorDate).toMatch(/^2026-01-01T\d{2}:00:00Z$/);
  });
});

describe('hunk attribution', () => {
  it('keeps every commit that accounts for a hunk instead of forcing one', async () => {
    const diff = await calc();
    expect(diff.hunks).toHaveLength(1);
    const lines = diff.hunks[0]?.lines.filter((l) => l.kind !== 'context') ?? [];
    expect(commitSet(lines)).toEqual([sha['A'], sha['B'], sha['C']].sort());
    expect(commitSet(lines.filter((l) => l.kind === 'added'))).toEqual([sha['B'], sha['C']].sort());
  });

  it('marks which side each commit belongs to, so a modified region shows both', async () => {
    const diff = await calc();
    const bySha = new Map(diff.commits.map((c) => [c.sha, c]));
    // A is in both histories: the Base line is shared history, Target's commits changed it.
    expect(bySha.get(sha['A'] ?? '')).toMatchObject({ inLeft: true, inRight: true });
    expect(bySha.get(sha['B'] ?? '')).toMatchObject({ inLeft: false, inRight: true });
    expect(bySha.get(sha['C'] ?? '')).toMatchObject({ inLeft: false, inRight: true });
  });
});

describe('file attribution', () => {
  it('one file, several divergence commits', async () => {
    const diff = await calc();
    expect(diff.commits.map((c) => c.sha).sort()).toEqual([sha['A'], sha['B'], sha['C']].sort());
  });

  it('skips git blame when attribution is not asked for, with the same hunks', async () => {
    const paths = { left: src('blue'), right: src('green'), rightPath: 'lib/other.txt' };
    const plain = await om.fileDiff({ ...paths, attribute: false });
    expect(plain.commits).toEqual([]);
    expect(plain.hunks.flatMap((h) => h.lines).every((l) => l.commit === undefined)).toBe(true);
    const attributed = await om.fileDiff(paths);
    expect(attributed.commits.map((c) => c.sha)).toEqual([sha['D']]);
    expect(plain.hunks.map((h) => h.header)).toEqual(attributed.hunks.map((h) => h.header));
  });

  it('one file, one divergence commit', async () => {
    const diff = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      rightPath: 'lib/other.txt',
    });
    expect(diff.commits.map((c) => c.sha)).toEqual([sha['D']]);
  });

  it('Base-side difference → Base attribution; the Target line is shared history', async () => {
    const diff = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'shared.txt',
      rightPath: 'shared.txt',
    });
    expect(commitOf(diff, 'TWO')).toBe(sha['E']);
    expect(commitOf(diff, 'two')).toBe(sha['base']);
    const bySha = new Map(diff.commits.map((c) => [c.sha, c]));
    expect(bySha.get(sha['E'] ?? '')).toMatchObject({ inLeft: true, inRight: false });
    expect(bySha.get(sha['base'] ?? '')).toMatchObject({ inLeft: true, inRight: true });
  });

  it('follows the direction: swapping sides swaps the attribution sides', async () => {
    const diff = await om.fileDiff({
      left: src('green'),
      right: src('blue'),
      leftPath: 'lib/calc.txt',
      rightPath: 'lib/calc.txt',
    });
    const value20 = changed(diff).find((l) => l.text === 'value = 20');
    expect(value20).toMatchObject({ kind: 'removed', commit: sha['C'] });
    expect(diff.commits.find((c) => c.sha === sha['C'])).toMatchObject({
      inLeft: true,
      inRight: false,
    });
  });
});

describe('directory scope', () => {
  it('one commit can account for several differences, one directory for several commits', async () => {
    const compare = await om.compare(src('blue'), src('green'));
    const lib = compare.root.children?.find((c) => c.name === 'lib');
    const differing = (lib?.children ?? [])
      .filter((c) => c.status !== 'identical')
      .map((c) => c.path);
    expect(differing.sort()).toEqual(['lib/calc.txt', 'lib/other.txt']);
    const diffs = await Promise.all(
      differing.map((p) =>
        om.fileDiff({
          left: src('blue'),
          right: src('green'),
          ...(p === 'lib/other.txt' ? {} : { leftPath: p }),
          rightPath: p,
        }),
      ),
    );
    const all = diffs.flatMap(changed);
    expect(commitSet(all)).toEqual([sha['A'], sha['B'], sha['C'], sha['D']].sort());
    // Nothing outside lib/ (E only touches shared.txt) is attributed to lib/.
    expect(commitSet(all)).not.toContain(sha['E']);
  });
});

describe('blob-less clones', () => {
  const omRepo = () =>
    path.join(base, 'data', 'users', 'attr', 'sessions', om.sessionId, 'repos', repo.id);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: omRepo(),
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
  const missing = () =>
    git('rev-list', '--objects', '--missing=print', sha['H5'] ?? '', '--', 'hist/h.txt')
      .split('\n')
      .filter((l) => l.startsWith('?'));

  it('fetches a file’s history in one request before blaming it', async () => {
    expect(git('config', '--get', 'remote.origin.promisor')).toBe('true');
    expect(missing().length).toBeGreaterThanOrEqual(4); // never checked out: history not local
    const packs = () => Number(/packs: (\d+)/.exec(git('count-objects', '-v'))?.[1]);
    const before = packs();
    const diff = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      rightPath: 'hist/h.txt',
    });
    expect(changed(diff).map((l) => l.commit)).toEqual([1, 2, 3, 4, 5].map((i) => sha[`H${i}`]));
    expect(missing()).toEqual([]);
    // The tip's content (read for the diff) plus one batch for the history; not one per version.
    expect(packs() - before).toBeLessThanOrEqual(2);
  });
});

describe('across remotes', () => {
  it('compares and attributes between two separate clones', async () => {
    const fork = scenario.fork(path.join(base, 'fork'));
    fork.branch('product', 'origin/green');
    const forkCommit = fork.commit(
      { 'lib/calc.txt': 'head\nvalue = 30\nlimit = 5\ntail\n' },
      'F: fork value',
      {
        author: BOB,
      },
    );
    const forkRepo = await om.addRepo(fork.url);
    const right = om.source(forkRepo, 'product');

    const compare = await om.compare(src('blue'), right);
    expect(compare.rightSnapshot?.commit).toBe(forkCommit);
    const diff = await om.fileDiff({
      left: src('blue'),
      right,
      leftPath: 'lib/calc.txt',
      rightPath: 'lib/calc.txt',
    });
    expect(commitOf(diff, 'value = 30')).toBe(forkCommit);
    expect(commitOf(diff, 'value = 10')).toBe(sha['A']);
    expect(diff.commits.find((c) => c.sha === forkCommit)).toMatchObject({
      inLeft: false,
      inRight: true,
    });
    expect(diff.commits.find((c) => c.sha === sha['A'])).toMatchObject({
      inLeft: true,
      inRight: true,
    });
  });
});
