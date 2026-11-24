import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitFile, GitFiles, GitGrep, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { Scenario } from './scenario.ts';

/*
 * Go-to-file and search read a commit's whole tree and its file contents, one commit at a time:
 *
 *   main:  A (layout) ── B (edits a.txt, adds big.txt and bin.dat)
 */

const BIG_BYTES = 5 * 1024 * 1024 + 1;

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
const c: Record<string, string> = {};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-files-'));
  const s = Scenario.fromSeed(path.join(base, 'origin'));
  c['A'] = s.commit(
    {
      'README.md': 'readme\n',
      'src/a.c': 'int main() {\n  return hello();\n}\n',
      'src/http/b.c': '/* hello from b */\n',
      'docs/guide.md': 'guide\n',
    },
    'A: layout',
  );
  c['B'] = s.commit(
    {
      'src/a.c': 'int main() {\n  return hello();\n}\n// Hello again\n',
      'big.txt': 'x'.repeat(BIG_BYTES),
      'bin.dat': 'x\0y',
    },
    'B: edits',
  );
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'files').start();
  repo = await om.addRepo(s.url);
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

/** A source pinned to one of this file's commits (by name) or to a branch. */
const src = (rev: string) => ({ type: 'git', repoId: repo.id, branch: c[rev] ?? rev });

describe('POST /api/git/files', () => {
  it('lists every file path of the commit, sorted, with no folders', async () => {
    const res = await om.inject('/api/git/files', { source: src('B') });
    expect(res.statusCode).toBe(200);
    const body = res.json<GitFiles>();
    expect(body.commit).toBe(c['B']);
    expect(body.truncated).toBe(false);
    // `README` comes from the Hello-World seed the scenario starts from. Sorted by code point.
    expect(body.paths).toEqual([
      'README',
      'README.md',
      'big.txt',
      'bin.dat',
      'docs/guide.md',
      'src/a.c',
      'src/http/b.c',
    ]);
  });

  it('lists the files of the commit asked for, not the branch tip', async () => {
    const body = (await om.inject('/api/git/files', { source: src('A') })).json<GitFiles>();
    expect(body.paths).not.toContain('big.txt');
  });
});

describe('POST /api/git/file', () => {
  it('returns a text file with its object id and size', async () => {
    const res = await om.inject('/api/git/file', { source: src('B'), path: 'src/a.c' });
    expect(res.statusCode).toBe(200);
    const body = res.json<GitFile>();
    expect(body.content).toBe('text');
    expect(body.text).toBe('int main() {\n  return hello();\n}\n// Hello again\n');
    expect(body.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(body.size).toBe(Buffer.byteLength(body.text ?? ''));
    expect(body.commit).toBe(c['B']);
    expect(body.path).toBe('src/a.c');
  });

  it('reports a binary file without its contents', async () => {
    const body = (
      await om.inject('/api/git/file', { source: src('B'), path: 'bin.dat' })
    ).json<GitFile>();
    expect(body.content).toBe('binary');
    expect(body.text).toBeUndefined();
  });

  it('reports a text file above the size limit as too large, without its contents', async () => {
    const body = (
      await om.inject('/api/git/file', { source: src('B'), path: 'big.txt' })
    ).json<GitFile>();
    expect(body.content).toBe('too-large');
    expect(body.size).toBe(BIG_BYTES);
    expect(body.text).toBeUndefined();
  });

  it('answers 404 for a path the commit does not have', async () => {
    const res = await om.inject('/api/git/file', { source: src('B'), path: 'nope.txt' });
    expect(res.statusCode).toBe(404);
  });

  it('answers 400 for a folder', async () => {
    const res = await om.inject('/api/git/file', { source: src('B'), path: 'src' });
    expect(res.statusCode).toBe(400);
  });

  it('serves the same file again from the cache, with the same answer', async () => {
    const first = (
      await om.inject('/api/git/file', { source: src('B'), path: 'src/http/b.c' })
    ).json<GitFile>();
    const second = (
      await om.inject('/api/git/file', { source: src('B'), path: 'src/http/b.c' })
    ).json<GitFile>();
    expect(second).toEqual(first);
  });
});

describe('POST /api/git/grep', () => {
  const grep = async (body: Record<string, unknown>) =>
    (await om.inject('/api/git/grep', { source: src('B'), ...body })).json<GitGrep>();

  it('finds fixed text in any file, ignoring case when asked', async () => {
    const body = await grep({ query: 'hello', ignoreCase: true });
    // The seed's README says "Hello World", so it matches too.
    expect(body.matches.map((m) => [m.path, m.line, m.column])).toEqual([
      ['README', 1, 1],
      ['src/a.c', 2, 10],
      ['src/a.c', 4, 4],
      ['src/http/b.c', 1, 4],
    ]);
    expect(body.matches[1]?.text).toBe('  return hello();');
    expect(body.truncated).toBe(false);
  });

  it('is case-sensitive by default', async () => {
    const body = await grep({ query: 'hello' });
    expect(body.matches.map((m) => m.line)).toEqual([2, 1]);
  });

  it('reads the query as a regular expression when asked', async () => {
    const body = await grep({ query: 'hel+o\\(\\)', regex: true });
    expect(body.matches.map((m) => [m.path, m.line])).toEqual([['src/a.c', 2]]);
  });

  it('treats regex characters literally for fixed text', async () => {
    const body = await grep({ query: 'hello()' });
    expect(body.matches.map((m) => m.line)).toEqual([2]);
    expect((await grep({ query: 'h.llo()' })).matches).toEqual([]);
  });

  it('limits the search to the paths asked for', async () => {
    const body = await grep({ query: 'hello', ignoreCase: true, paths: ['src/http'] });
    expect(body.matches.map((m) => m.path)).toEqual(['src/http/b.c']);
  });

  it('gives up to the asked number of lines before and after each match', async () => {
    const body = await grep({ query: 'return hello', context: 1, paths: ['src/a.c'] });
    expect(body.matches).toEqual([
      {
        path: 'src/a.c',
        line: 2,
        column: 3,
        text: '  return hello();',
        before: [{ line: 1, text: 'int main() {' }],
        after: [{ line: 3, text: '}' }],
      },
    ]);
  });

  it('answers 400 for an empty query and 400 for a path that escapes the tree', async () => {
    expect((await om.inject('/api/git/grep', { source: src('B'), query: '' })).statusCode).toBe(
      400,
    );
    expect(
      (await om.inject('/api/git/grep', { source: src('B'), query: 'a', paths: ['../x'] }))
        .statusCode,
    ).toBe(400);
  });
});

describe('POST /api/git/diff with fullFile on identical files', () => {
  it('shows an identical file as one context hunk of its whole text', async () => {
    const res = await om.inject('/api/git/diff', {
      left: src('A'),
      right: src('B'),
      files: [{ leftPath: 'README.md', rightPath: 'README.md' }],
      fullFile: true,
    });
    const [file] = res.json<{
      files: Array<{
        content: string;
        hunks: Array<{ lines: Array<{ kind: string; text: string; leftLine?: number }> }>;
      }>;
    }>().files;
    expect(file?.content).toBe('identical');
    expect(file?.hunks).toEqual([
      {
        header: '@@ -1,1 +1,1 @@',
        leftStart: 1,
        leftCount: 1,
        rightStart: 1,
        rightCount: 1,
        lines: [{ kind: 'context', text: 'readme', leftLine: 1, rightLine: 1 }],
      },
    ]);
  });

  it('keeps identical files without hunks when the full file is not asked for', async () => {
    const res = await om.inject('/api/git/diff', {
      left: src('A'),
      right: src('B'),
      files: [{ leftPath: 'README.md', rightPath: 'README.md' }],
    });
    const [file] = res.json<{ files: Array<{ content: string; hunks: unknown[] }> }>().files;
    expect(file?.content).toBe('identical');
    expect(file?.hunks).toEqual([]);
  });
});
