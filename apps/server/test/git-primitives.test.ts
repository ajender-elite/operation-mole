import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { Scenario } from './scenario.ts';

/*
 * The git primitives on real repositories (POST /api/git/<op>). History (main):
 *
 *   S ── C1 ── C2 ── C3(rename a.txt) ── C4(binary) ──┐
 *         │                                           M (merge)
 *         ├── T1 (topic.txt) ─────────────────────────┘
 *         └── K1 (a.txt "x" then "z": conflicts with C2 on the same line)
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const c: Record<string, string> = {};
const user = 'primitives';

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-primitives-'));
  const s = Scenario.fromSeed(path.join(base, 'origin'));
  c['S'] = s.commit({ 'a.txt': 'x\n' }, 'S: base');
  c['C1'] = s.commit({ 'one.txt': '1\n' }, 'C1: one');
  c['C2'] = s.commit({ 'a.txt': 'x\ny\n' }, 'C2: add a line');
  s.branch('topic', c['C1']);
  c['T1'] = s.commit({ 'topic.txt': 't\n' }, 'T1: topic work');
  s.branch('conflict', c['C1']);
  c['K1'] = s.commit({ 'a.txt': 'x\nz\n' }, 'K1: conflicting line');
  // The same change as C2, made on a different base: a patch-equivalent commit.
  s.branch('eq', c['C1']);
  c['EQ'] = s.commit({ 'a.txt': 'x\ny\n' }, 'EQ: the same change as C2');
  s.checkout('main');
  c['C3'] = s.move('a.txt', 'renamed.txt', 'C3: rename a');
  c['C4'] = s.commit({ 'bin.dat': 'x\0y' }, 'C4: binary file');
  c['M'] = s.merge('topic', 'M: merge topic');
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, user).start();
  repo = await om.addRepo(s.url);
}, 120_000); // builds a history with a dozen git commands; 30s is too tight under load (see nginx-branches.test.ts)

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

const src = (rev: string) => ({ type: 'git' as const, repoId: repo.id, branch: c[rev] ?? rev });

describe('POST /api/git/resolve', () => {
  it('resolves branches, tags and commits to full SHAs, in one call', async () => {
    const res = await om.inject('/api/git/resolve', { sources: [src('M'), src('C1')] });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ revisions: Array<{ commit: string; ref: string }> }>();
    expect(body.revisions.map((r) => r.commit)).toEqual([c['M'], c['C1']]);
    expect(body.revisions[0]?.ref).toBe(c['M']);
  });

  it('answers 400 for a revision that does not exist', async () => {
    const res = await om.inject('/api/git/resolve', {
      sources: [{ type: 'git', repoId: repo.id, branch: 'no-such-branch' }],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/git/merge-base', () => {
  it('finds the commit two histories share', async () => {
    const res = await om.inject('/api/git/merge-base', { a: src('M'), b: src('T1') });
    expect(res.json<{ commit: string | null }>().commit).toBe(c['T1']);
    const topic = await om.inject('/api/git/merge-base', { a: src('C2'), b: src('T1') });
    expect(topic.json<{ commit: string | null }>().commit).toBe(c['C1']);
  });
});

describe('POST /api/git/ancestry', () => {
  it('says for each commit whether it is in the history of the tip', async () => {
    const res = await om.inject('/api/git/ancestry', {
      tip: src('M'),
      commits: [c['C1'], c['T1']],
    });
    expect(res.json<{ results: Array<{ isAncestor: boolean | null }> }>().results).toEqual([
      { commit: c['C1'], isAncestor: true },
      { commit: c['T1'], isAncestor: true },
    ]);
    const other = await om.inject('/api/git/ancestry', { tip: src('C2'), commits: [c['T1']] });
    expect(
      other.json<{ results: Array<{ isAncestor: boolean | null }> }>().results[0]?.isAncestor,
    ).toBe(false);
  });

  it('says null, not false, when git cannot tell (an unknown commit)', async () => {
    const unknown = 'f'.repeat(40);
    const res = await om.inject('/api/git/ancestry', { tip: src('M'), commits: [unknown] });
    expect(
      res.json<{ results: Array<{ isAncestor: boolean | null }> }>().results[0]?.isAncestor,
    ).toBeNull();
  });
});

describe('POST /api/git/blame', () => {
  it('attributes each line of a file at a commit to the commit that wrote it', async () => {
    const res = await om.inject('/api/git/blame', { source: src('C2'), path: 'a.txt' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      commit: string;
      lines: Array<{ line: number; commit: string; origLine: number }>;
      commits: Array<{ sha: string; subject: string }>;
    }>();
    expect(body.commit).toBe(c['C2']);
    expect(body.lines.map((l) => [l.line, l.commit])).toEqual([
      [1, c['S']],
      [2, c['C2']],
    ]);
    expect(body.commits.find((x) => x.sha === c['C2'])?.subject).toBe('C2: add a line');
  });

  it('can blame only the lines asked for', async () => {
    const res = await om.inject('/api/git/blame', { source: src('C2'), path: 'a.txt', lines: [2] });
    expect(res.json<{ lines: Array<{ line: number }> }>().lines.map((l) => l.line)).toEqual([2]);
  });

  it('reports a file that does not exist at that commit as not found', async () => {
    const res = await om.inject('/api/git/blame', { source: src('C2'), path: 'missing.txt' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/git/diff', () => {
  it('returns each file pair as hunks, with no attribution', async () => {
    const res = await om.inject('/api/git/diff', {
      left: src('S'),
      right: src('C2'),
      files: [{ leftPath: 'a.txt', rightPath: 'a.txt' }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      files: Array<{
        content: string;
        hunks: Array<{ lines: Array<{ kind: string; text: string }> }>;
        commits: unknown[];
      }>;
    }>();
    const [file] = body.files;
    expect(file?.content).toBe('text');
    expect(file?.hunks[0]?.lines.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual([
      'y',
    ]);
    expect(file?.commits).toEqual([]);
  });

  it('reads a file renamed on the other side as a pair of paths', async () => {
    const res = await om.inject('/api/git/diff', {
      left: src('C2'),
      right: src('C3'),
      files: [{ leftPath: 'a.txt', rightPath: 'renamed.txt' }],
    });
    const body = res.json<{ files: Array<{ content: string }> }>();
    expect(body.files[0]?.content).toBe('identical');
  });
});

describe('POST /api/git/merge-tree', () => {
  it('reports a clean merge of two histories', async () => {
    const res = await om.inject('/api/git/merge-tree', { ours: src('C2'), theirs: src('T1') });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ isClean: boolean; conflictedPaths: string[]; base: string | null }>();
    expect(body.isClean).toBe(true);
    expect(body.conflictedPaths).toEqual([]);
    expect(body.base).toBe(c['C1']);
  });

  it('lists the paths that conflict, and leaves no objects behind', async () => {
    const res = await om.inject('/api/git/merge-tree', { ours: src('C2'), theirs: src('K1') });
    const body = res.json<{ isClean: boolean; conflictedPaths: string[] }>();
    expect(body.isClean).toBe(false);
    expect(body.conflictedPaths).toEqual(['a.txt']);
  });
});

describe('POST /api/git/compare-trees', () => {
  it('compares two trees file by file, with each file’s status and any renames', async () => {
    const res = await om.inject('/api/git/compare-trees', { left: src('C1'), right: src('M') });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      entries: Array<{ path: string; status: string }>;
      renames: Array<{ from: string; to: string; similarity: number }>;
    }>();
    const status = new Map(body.entries.map((e) => [e.path, e.status]));
    expect(status.get('one.txt')).toBe('identical');
    expect(status.get('topic.txt')).toBe('only-right');
    expect(status.get('bin.dat')).toBe('only-right');
    expect(status.get('a.txt')).toBe('only-left');
    // C2 added a line before C3 renamed the file, so git sees half of it as the same content.
    expect(body.renames).toEqual([{ from: 'a.txt', to: 'renamed.txt', similarity: 50 }]);
  });

  it('reports a file that changed content as modified, with both sides’ details', async () => {
    const mod = await om.inject('/api/git/compare-trees', { left: src('S'), right: src('C2') });
    const modified = mod.json<{
      entries: Array<{ path: string; status: string; left?: { size: number } }>;
    }>();
    const change = modified.entries.find((e) => e.path === 'a.txt');
    expect(change?.status).toBe('modified');
    expect(change?.left?.size).toBe(2);
  });

  it('can narrow the comparison to some paths', async () => {
    const res = await om.inject('/api/git/compare-trees', {
      left: src('C1'),
      right: src('M'),
      paths: ['topic.txt'],
    });
    expect(res.json<{ entries: Array<{ path: string }> }>().entries.map((e) => e.path)).toEqual([
      'topic.txt',
    ]);
  });

  it('also gives the folder tree Folder Compare shows: its labels, snapshots and summary', async () => {
    const res = await om.inject('/api/git/compare-trees', { left: src('C1'), right: src('M') });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      entries: Array<{ status: string }>;
      folder: {
        leftLabel: string;
        rightLabel: string;
        leftSnapshot?: { commit: string; ref: string };
        rightSnapshot?: { commit: string; ref: string };
        summary: { onlyRight: number; onlyLeft: number; identical: number; modified: number };
        root: { children?: unknown[] };
      };
    }>();
    expect(body.folder.leftLabel).toContain(' @ ');
    expect(body.folder.rightLabel).toContain(' @ ');
    expect(body.folder.leftSnapshot?.commit).toBe(c['C1']);
    expect(body.folder.rightSnapshot?.commit).toBe(c['M']);
    expect(body.folder.summary.onlyRight).toBe(
      body.entries.filter((e) => e.status === 'only-right').length,
    );
    expect(body.folder.root.children?.length).toBeGreaterThan(0);
  });
});

describe('POST /api/git/patch-equivalents', () => {
  it('pairs commits that make the same change, and marks the others by side', async () => {
    const res = await om.inject('/api/git/patch-equivalents', {
      left: src('EQ'),
      right: src('C2'),
      exclude: src('C1'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ commits: Array<{ commit: { sha: string }; mark: string }> }>();
    expect(
      body.commits
        .filter((x) => x.mark === 'equivalent')
        .map((x) => x.commit.sha)
        .sort(),
    ).toEqual([c['C2'], c['EQ']].sort());
  });

  it('marks a commit that has no equivalent as belonging to its side', async () => {
    const res = await om.inject('/api/git/patch-equivalents', {
      left: src('T1'),
      right: src('C2'),
      exclude: src('C1'),
    });
    const body = res.json<{ commits: Array<{ commit: { sha: string }; mark: string }> }>();
    expect(body.commits.find((x) => x.commit.sha === c['T1'])?.mark).toBe('left');
    expect(body.commits.find((x) => x.commit.sha === c['C2'])?.mark).toBe('right');
  });
});

describe('merge-tree: what it changes and what it leaves in conflict', () => {
  it('lists the paths the merge changes relative to ours', async () => {
    const res = await om.inject('/api/git/merge-tree', { ours: src('C2'), theirs: src('T1') });
    expect(res.json<{ changedPaths: string[] }>().changedPaths).toEqual(['topic.txt']);
  });

  it('gives the merged text of each conflicted file, with the conflict markers', async () => {
    const res = await om.inject('/api/git/merge-tree', { ours: src('C2'), theirs: src('K1') });
    const body = res.json<{ conflictedFiles: Array<{ path: string; text: string | null }> }>();
    const file = body.conflictedFiles.find((f) => f.path === 'a.txt');
    expect(file?.text).toContain('<<<<<<<');
  });
});
