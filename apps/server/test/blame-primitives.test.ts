import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitBlame, GitSource, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { ALICE, BOB, Scenario } from './scenario.ts';

/*
 * Blame, as the File Compare asks for it: the commit that last changed each line, in the history of
 * the side it is asked about. Same fixture history as the attribution cases it replaces:
 *
 *   base ── A (creates calc.txt with X) ── [blue]
 *             └── B (adds Y after X) ── C (rewrites X) ── D (lib/other.txt) ── [green]
 *   base ── … ── E (blue-only: shared.txt line 2) on [blue]
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const sha: Record<string, string> = {};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-blame-'));
  const scenario = Scenario.fromSeed(path.join(base, 'origin'));
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
  om = await new OmClient(app, 'blame').start();
  repo = await om.addRepo(scenario.url);
}, 120_000); // builds a full history with many git processes; the 30s default is too tight under load
afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const src = (ref: string): GitSource => om.source(repo, ref);

async function blame(ref: string, filePath: string): Promise<GitBlame> {
  const res = await om.inject('/api/git/blame', {
    user: om.user,
    sessionId: om.sessionId,
    source: src(ref),
    path: filePath,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<GitBlame>();
}

const commitOfLine = (b: GitBlame, line: number) => b.lines.find((l) => l.line === line)?.commit;

describe('blame of a file on one side', () => {
  it('names the commit that last changed each line, not the one that introduced it', async () => {
    const b = await blame('green', 'lib/calc.txt');
    expect(commitOfLine(b, 1)).toBe(sha['A']); // head: never changed
    expect(commitOfLine(b, 2)).toBe(sha['C']); // value: rewritten by C
    expect(commitOfLine(b, 3)).toBe(sha['B']); // limit: added by B
    expect(commitOfLine(b, 4)).toBe(sha['A']); // tail: never changed
  });

  it('blames each side in its own history: blue’s edit is blue’s', async () => {
    const b = await blame('blue', 'shared.txt');
    expect(commitOfLine(b, 2)).toBe(sha['E']);
  });
});

describe('blob-less clones', () => {
  const omRepo = () =>
    path.join(base, 'data', 'users', 'blame', 'sessions', om.sessionId, 'repos', repo.id);
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
    const b = await blame('green', 'hist/h.txt');
    expect(new Set(b.lines.map((l) => l.commit))).toEqual(
      new Set([1, 2, 3, 4, 5].map((i) => sha[`H${i}`])),
    );
    expect(missing()).toEqual([]);
    // One batch for the history, not one fetch per version.
    expect(packs() - before).toBeLessThanOrEqual(2);
  });
});
