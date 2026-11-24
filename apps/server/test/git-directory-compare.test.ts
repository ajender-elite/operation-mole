import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompareNode, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { Scenario } from './scenario.ts';

/*
 * Folder Compare of two git refs, computed from the trees (no checkout). Left is `main`, Right
 * is `right`:
 *
 *   main:  keep.txt   clash (a file)   dir/one.txt   dir/two.txt
 *   right: keep.txt   clash/x.txt (a folder now)     dir/two.txt (changed)   dir/three.txt
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const user = 'dircompare';

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-dir-compare-'));
  const s = Scenario.fromSeed(path.join(base, 'origin'));
  s.commit(
    { 'keep.txt': 'k\n', clash: 'a file\n', 'dir/one.txt': '1\n', 'dir/two.txt': '2\n' },
    'main: the starting folders',
  );
  s.branch('right');
  s.commit(
    {
      clash: null,
      'clash/x.txt': 'x\n',
      'dir/two.txt': '2 changed\n',
      'dir/three.txt': '3\n',
    },
    'right: the changes',
  );
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, user).start();
  repo = await om.addRepo(s.url);
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

/** The node at `p` in the result tree; a folder is found by path, a file by path too. */
function find(root: CompareNode, p: string): CompareNode[] {
  const parts = p.split('/');
  let level: CompareNode[] = root.children ?? [];
  let found: CompareNode[] = [];
  for (const [i, part] of parts.entries()) {
    const matches = level.filter((n) => n.name === part);
    if (i === parts.length - 1) found = matches;
    level = matches.flatMap((n) => n.children ?? []);
  }
  return found;
}

describe('Folder Compare of git refs, from trees', () => {
  it('marks each path by what each side has, with folders following their files', async () => {
    const result = await om.compare(om.source(repo, 'main'), om.source(repo, 'right'));
    const root = result.root;
    expect(find(root, 'keep.txt')[0]?.status).toBe('identical');
    expect(find(root, 'dir')[0]?.status).toBe('modified');
    expect(find(root, 'dir/one.txt')[0]?.status).toBe('identical');
    expect(find(root, 'dir/two.txt')[0]?.status).toBe('modified');
    expect(find(root, 'dir/three.txt')[0]?.status).toBe('only-right');
    // README.md (from the seed), keep.txt and dir/one.txt are unchanged; the Right commit only adds to the tree.
    expect(result.summary).toMatchObject({ identical: 3, modified: 1, onlyLeft: 1, onlyRight: 2 });
  });

  it('lists a file and a folder with the same name as two one-sided entries', async () => {
    const result = await om.compare(om.source(repo, 'main'), om.source(repo, 'right'));
    const clash = result.root.children?.filter((n) => n.name === 'clash') ?? [];
    expect(clash.map((n) => n.status).sort()).toEqual(['only-left', 'only-right']);
    expect(clash.find((n) => n.status === 'only-right')?.left).toBeUndefined();
  });

  it('keeps the folders first, then the files, in the server’s order', async () => {
    const result = await om.compare(om.source(repo, 'main'), om.source(repo, 'right'));
    const names = (result.root.children ?? []).map((n) => n.name);
    expect(names.indexOf('dir')).toBeLessThan(names.indexOf('keep.txt'));
  });

  it('reads from the trees: no worktree is created for either side', async () => {
    await om.compare(om.source(repo, 'main'), om.source(repo, 'right'));
    const worktrees = path.join(base, 'data', 'users', user, 'sessions', om.sessionId, 'worktrees');
    expect(existsSync(worktrees)).toBe(false);
  });
});
