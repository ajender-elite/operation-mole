import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitTree, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { Scenario } from './scenario.ts';

/*
 * POST /api/git/tree: one level of a commit's tree, as `git ls-tree` lists it. Folders come first,
 * then files, each group in the order Folder Compare uses (natural, case-insensitive).
 *
 *   main:   A (layout) ── L (legacy only, on branch "legacy")
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-tree-'));
  const s = Scenario.fromSeed(path.join(base, 'origin'));
  s.commit(
    {
      'README.md': 'readme\n',
      'file10.txt': '10\n',
      'file2.txt': '2\n',
      'src/a.c': 'a\n',
      'src/http/b.c': 'b\n',
      'docs/guide.md': 'guide\n',
    },
    'A: layout',
  );
  s.branch('legacy');
  s.checkout('legacy');
  s.commit({ 'legacy.txt': 'old\n' }, 'L: legacy only');
  s.checkout('main');
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'tree').start();
  repo = await om.addRepo(s.url);
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

async function tree(branch: string, filePath?: string) {
  return await om.inject('/api/git/tree', {
    source: { type: 'git', repoId: repo.id, branch },
    ...(filePath === undefined ? {} : { path: filePath }),
  });
}

const names = (t: GitTree) => t.entries.map((e) => [e.name, e.kind]);

describe('POST /api/git/tree', () => {
  it('lists the root: folders first, then files, in natural order', async () => {
    const res = await tree('main');
    expect(res.statusCode).toBe(200);
    const body = res.json<GitTree>();
    expect(body.path).toBe('');
    // `README` comes from the Hello-World seed the scenario starts from.
    expect(names(body)).toEqual([
      ['docs', 'directory'],
      ['src', 'directory'],
      ['file2.txt', 'file'],
      ['file10.txt', 'file'],
      ['README', 'file'],
      ['README.md', 'file'],
    ]);
  });

  it('lists one folder level, with each entry’s full path', async () => {
    const body = (await tree('main', 'src')).json<GitTree>();
    expect(body.path).toBe('src');
    expect(body.entries).toEqual([
      expect.objectContaining({ name: 'http', path: 'src/http', kind: 'directory' }),
      expect.objectContaining({ name: 'a.c', path: 'src/a.c', kind: 'file' }),
    ]);
  });

  it('does not list the contents of subfolders', async () => {
    const body = (await tree('main', 'src/http')).json<GitTree>();
    expect(names(body)).toEqual([['b.c', 'file']]);
  });

  it('gives each entry its object id and the resolved commit', async () => {
    const body = (await tree('main')).json<GitTree>();
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const entry of body.entries) expect(entry.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reads the tree of the branch it is asked for', async () => {
    expect(names((await tree('legacy')).json<GitTree>())).toContainEqual(['legacy.txt', 'file']);
    expect(names((await tree('main')).json<GitTree>())).not.toContainEqual(['legacy.txt', 'file']);
  });

  it('answers 400 for a path that is a file, not a folder', async () => {
    expect((await tree('main', 'README.md')).statusCode).toBe(400);
  });

  it('answers 404 for a folder that does not exist', async () => {
    expect((await tree('main', 'nope')).statusCode).toBe(404);
  });

  it('refuses a path that escapes the tree', async () => {
    expect((await tree('main', '../etc')).statusCode).toBe(400);
  });
});
