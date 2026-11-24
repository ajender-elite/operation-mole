import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CompareNode,
  FolderComparison,
  GitAncestry,
  GitBlame,
  GitSource,
  RepoInfo,
} from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { SEED_COMMIT, SEED_FIRST, SEED_NEWLINE, Scenario } from './scenario.ts';

/*
 * Snapshot comparison between git snapshots, against real git: every directory/file state,
 * renames, binary and oversized files, snapshot identity (branch, tag, commit), both directions.
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
let scenario: Scenario;

const LONG = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a file long enough to rename`);
const long = (lines: string[]) => `${lines.join('\n')}\n`;
const PNG_1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3]);
const PNG_2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 9, 9, 9]);

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-snapshots-'));
  scenario = Scenario.fromSeed(path.join(base, 'origin'));
  scenario.commit(
    {
      'src/a.txt': 'alpha\n',
      'src/b.txt': 'beta\n',
      'docs/guide.md': '# Guide\n',
      'docs/keep.md': 'keep\n',
      'old/x.txt': 'x\n',
      'old/deep/y.txt': 'y\n',
      'rename-me.txt': long(LONG),
      'rename-mod.txt': long(LONG.map((l) => l.toUpperCase())),
      'assets/logo.png': PNG_1,
      'big.txt': 'small\n',
    },
    'Left layout',
  );
  scenario.branch('blue');
  scenario.tag('v1.0');
  scenario.branch('same', 'blue');
  scenario.branch('green', 'blue');
  scenario.commit(
    {
      'src/a.txt': 'alpha changed\n',
      'src/b.txt': 'beta changed\n',
      'docs/guide.md': null,
      'old/x.txt': null,
      'old/deep/y.txt': null,
      'new/dir/n.txt': 'new\n',
      'added.txt': 'added\n',
      'assets/logo.png': PNG_2,
      'big.txt': `${'0123456789'.repeat(600)}\n`,
    },
    'Green changes',
  );
  scenario.move('rename-me.txt', 'renamed.txt', 'Rename unchanged');
  const mod = LONG.map((l) => l.toUpperCase());
  mod[10] = 'THIS LINE WAS EDITED';
  scenario.move('rename-mod.txt', 'moved/renamed-mod.txt', 'Rename and modify', {
    'moved/renamed-mod.txt': long(mod),
  });

  app = buildApp({
    dataDir: path.join(base, 'data'),
    allowedProtocols: ['https', 'ssh', 'file'],
    maxTextFileBytes: 5000,
  });
  await app.ready();
  om = await new OmClient(app, 'snap').start();
  repo = await om.addRepo(scenario.url);
}, 120_000); // builds a full history with many git processes; the 30s default is too tight under load
afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const src = (ref: string): GitSource => om.source(repo, ref);

function node(result: FolderComparison, p: string, kind: 'dir' | 'file' = 'file'): CompareNode {
  const found: CompareNode[] = [];
  const walk = (n: CompareNode) => {
    if (n.path === p) found.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(result.root);
  const match = found.find((n) => (kind === 'dir') === (n.children !== undefined));
  if (!match) throw new Error(`no ${kind} ${p}`);
  return match;
}

describe('snapshot identity', () => {
  it('reports the exact commit each side resolved to', async () => {
    const result = await om.compare(src('blue'), src('green'));
    expect(result.leftSnapshot).toEqual({ commit: scenario.rev('blue'), ref: 'blue' });
    expect(result.rightSnapshot).toEqual({ commit: scenario.rev('green'), ref: 'green' });
  });

  it('accepts a tag or a commit SHA instead of a branch', async () => {
    const sha = scenario.rev('green');
    const result = await om.compare(src('v1.0'), src(sha.slice(0, 12)));
    expect(result.leftSnapshot?.commit).toBe(scenario.rev('blue'));
    expect(result.rightSnapshot).toEqual({ commit: sha, ref: sha.slice(0, 12) });
    expect(result.summary.modified).toBeGreaterThan(0);
  });

  it('treats two refs to the same commit as identical snapshots', async () => {
    const result = await om.compare(src('blue'), src('same'));
    expect(result.root.status).toBe('identical');
    expect(result.summary).toMatchObject({ modified: 0, onlyLeft: 0, onlyRight: 0 });
    expect(result.leftSnapshot?.commit).toBe(result.rightSnapshot?.commit);
  });
});

describe('Left → Right', () => {
  let r: FolderComparison;
  beforeAll(async () => {
    r = await om.compare(src('blue'), src('green'));
  });

  it('classifies modified, added and removed files', () => {
    expect(node(r, 'src/a.txt').status).toBe('modified');
    expect(node(r, 'src/b.txt').status).toBe('modified');
    expect(node(r, 'src', 'dir').status).toBe('modified');
    expect(node(r, 'added.txt').status).toBe('only-right');
    expect(node(r, 'docs/guide.md').status).toBe('only-left');
    expect(node(r, 'docs/keep.md').status).toBe('identical');
    expect(node(r, 'README').status).toBe('identical');
  });

  it('classifies added and removed directories', () => {
    expect(node(r, 'old', 'dir').status).toBe('only-left');
    expect(node(r, 'old/deep/y.txt').status).toBe('only-left');
    expect(node(r, 'new', 'dir').status).toBe('only-right');
    expect(node(r, 'new/dir/n.txt').status).toBe('only-right');
  });

  it('links a pure rename and a rename with modification', () => {
    expect(node(r, 'rename-me.txt')).toMatchObject({
      status: 'only-left',
      renamedTo: 'renamed.txt',
      similarity: 100,
    });
    expect(node(r, 'renamed.txt')).toMatchObject({
      status: 'only-right',
      renamedFrom: 'rename-me.txt',
      similarity: 100,
    });
    const before = node(r, 'rename-mod.txt');
    expect(before.renamedTo).toBe('moved/renamed-mod.txt');
    expect(before.similarity).toBeGreaterThan(50);
    expect(before.similarity).toBeLessThan(100);
    expect(node(r, 'moved/renamed-mod.txt').renamedFrom).toBe('rename-mod.txt');
  });

  it('counts each file once', () => {
    expect(r.summary).toMatchObject({ onlyLeft: 5, onlyRight: 4, modified: 4 });
  });
});

describe('Right → Left (the reverse direction)', () => {
  it('mirrors every status and rename', async () => {
    const forward = await om.compare(src('blue'), src('green'));
    const back = await om.compare(src('green'), src('blue'));
    expect(back.summary).toEqual({
      ...forward.summary,
      onlyLeft: forward.summary.onlyRight,
      onlyRight: forward.summary.onlyLeft,
    });
    expect(node(back, 'added.txt').status).toBe('only-left');
    expect(node(back, 'old', 'dir').status).toBe('only-right');
    expect(node(back, 'renamed.txt').renamedTo).toBe('rename-me.txt');
    expect(node(back, 'rename-me.txt').renamedFrom).toBe('renamed.txt');
  });
});

describe('file diffs between snapshots', () => {
  it('returns git hunks with Left and Right line numbers', async () => {
    const diff = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'src/a.txt',
      rightPath: 'src/a.txt',
    });
    expect(diff.content).toBe('text');
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines.map((l) => [l.kind, l.text, l.leftLine, l.rightLine])).toEqual([
      ['removed', 'alpha', 1, undefined],
      ['added', 'alpha changed', undefined, 1],
    ]);
  });

  it('reads the diff in the requested direction', async () => {
    const diff = await om.fileDiff({
      left: src('green'),
      right: src('blue'),
      leftPath: 'src/a.txt',
      rightPath: 'src/a.txt',
    });
    expect(diff.hunks[0]?.lines.map((l) => [l.kind, l.text])).toEqual([
      ['removed', 'alpha changed'],
      ['added', 'alpha'],
    ]);
  });

  it('shows a one-sided file as entirely added or removed', async () => {
    const added = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      rightPath: 'added.txt',
    });
    expect(added.hunks[0]?.lines).toEqual([
      expect.objectContaining({ kind: 'added', text: 'added', rightLine: 1 }),
    ]);
    const removed = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'docs/guide.md',
    });
    expect(removed.hunks[0]?.lines[0]).toMatchObject({ kind: 'removed', text: '# Guide' });
  });

  it('diffs a renamed file against its old path', async () => {
    const pure = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'rename-me.txt',
      rightPath: 'renamed.txt',
    });
    expect(pure.content).toBe('identical');
    expect(pure.hunks).toEqual([]);
    const modified = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'rename-mod.txt',
      rightPath: 'moved/renamed-mod.txt',
    });
    const changed = modified.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
    expect(changed.map((l) => l.text)).toEqual([
      'LINE 11 OF A FILE LONG ENOUGH TO RENAME',
      'THIS LINE WAS EDITED',
    ]);
  });

  it('can include the whole file as context', async () => {
    const diff = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'rename-mod.txt',
      rightPath: 'moved/renamed-mod.txt',
      fullFile: true,
    });
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines.filter((l) => l.kind === 'context')).toHaveLength(29);
  });

  it('does not text-diff binary or oversized files', async () => {
    const binary = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'assets/logo.png',
      rightPath: 'assets/logo.png',
    });
    expect(binary).toMatchObject({ content: 'binary', hunks: [] });
    const big = await om.fileDiff({
      left: src('blue'),
      right: src('green'),
      leftPath: 'big.txt',
      rightPath: 'big.txt',
    });
    expect(big).toMatchObject({ content: 'too-large', hunks: [] });
  });

  it('rejects unknown paths and paths outside the snapshot', async () => {
    const missing = await om.inject('/api/git/diff', {
      user: om.user,
      sessionId: om.sessionId,
      left: src('blue'),
      right: src('green'),
      files: [{ leftPath: 'nope.txt' }],
    });
    expect(missing.statusCode).toBe(404);
    const escape = await om.inject('/api/git/diff', {
      user: om.user,
      sessionId: om.sessionId,
      left: src('blue'),
      right: src('green'),
      files: [{ leftPath: '../etc/passwd' }],
    });
    expect(escape.statusCode).toBe(400);
    const magic = await om.inject('/api/git/diff', {
      user: om.user,
      sessionId: om.sessionId,
      left: src('blue'),
      right: src('green'),
      files: [{ leftPath: ':(glob)**' }],
    });
    expect(magic.statusCode).toBe(404);
  });
});

describe('the pinned public seed', () => {
  it('compares Hello-World commits by SHA and attributes the README change', async () => {
    const first = await om.compare(src(SEED_FIRST), src(SEED_COMMIT));
    expect(node(first, 'README').status).toBe('modified');
    const diff = await om.fileDiff({
      left: src(SEED_FIRST),
      right: src(SEED_COMMIT),
      leftPath: 'README',
      rightPath: 'README',
    });
    const added = diff.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'added');
    // Git blame, on the right side, names the commit that added the line; ancestry says which side has it.
    const res = await om.inject('/api/git/blame', {
      user: om.user,
      sessionId: om.sessionId,
      source: src(SEED_COMMIT),
      path: 'README',
      lines: [added?.rightLine ?? 0],
    });
    const blame = res.json<GitBlame>();
    expect(blame.lines[0]?.commit).toBe(SEED_NEWLINE);
    expect(blame.commits.find((c) => c.sha === SEED_NEWLINE)).toMatchObject({
      authorName: 'Johnneylee Jack Rollins',
      authorDate: '2011-09-13T21:42:41-07:00',
    });
    const ancestry = await om.inject('/api/git/ancestry', {
      user: om.user,
      sessionId: om.sessionId,
      tip: src(SEED_FIRST),
      commits: [SEED_NEWLINE],
    });
    expect(ancestry.json<GitAncestry>().results[0]?.isAncestor).toBe(false);
  });
});
