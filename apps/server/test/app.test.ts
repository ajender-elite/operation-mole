import path from 'node:path';
import type { DirectoryCompareResult, FileCompareResult } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createWorkspace, writeTree } from './fixtures.ts';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let app: FastifyInstance;

beforeAll(async () => {
  ws = await createWorkspace();
  await writeTree(ws.base, {
    left: { 'a.txt': 'line1\nline2\n', 'only-left.txt': 'L' },
    right: { 'a.txt': 'line1\nchanged\n', 'only-right.txt': 'R' },
    'copy1.txt': 'same',
    'copy2.txt': 'same',
    'bin.dat': Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]),
    'big.txt': 'x'.repeat(200),
  });
  app = buildApp({ maxTextFileBytes: 100 });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ws.cleanup();
});

const p = (...parts: string[]) => path.join(ws.base, ...parts);

describe('POST /api/compare/directories', () => {
  it('returns the comparison tree', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/compare/directories',
      payload: { left: p('left'), right: p('right') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<DirectoryCompareResult>();
    expect(body.summary).toEqual({
      identical: 0,
      modified: 1,
      onlyLeft: 1,
      onlyRight: 1,
      errors: 0,
    });
    expect(body.root.children?.map((c) => [c.name, c.status])).toEqual([
      ['a.txt', 'modified'],
      ['only-left.txt', 'only-left'],
      ['only-right.txt', 'only-right'],
    ]);
  });

  it('rejects a missing or relative path with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/compare/directories',
      payload: { left: 'relative/path' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toBeTruthy();
  });

  it('rejects a non-existent directory with 400 naming the path', async () => {
    const missing = p('does-not-exist');
    const res = await app.inject({
      method: 'POST',
      url: '/api/compare/directories',
      payload: { left: p('left'), right: missing },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain(missing);
  });
});

describe('GET /api/compare/files', () => {
  const get = (query: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/compare/files', query });

  it('returns both text files and whether they are identical', async () => {
    const res = await get({ left: p('left', 'a.txt'), right: p('right', 'a.txt') });
    expect(res.statusCode).toBe(200);
    const body = res.json<FileCompareResult>();
    expect(body.identical).toBe(false);
    expect(body.left?.content).toBe('line1\nline2\n');
    expect(body.right?.content).toBe('line1\nchanged\n');
    expect(body.left?.binary).toBe(false);
    expect(body.left?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports identical files', async () => {
    const body = (
      await get({ left: p('copy1.txt'), right: p('copy2.txt') })
    ).json<FileCompareResult>();
    expect(body.identical).toBe(true);
    expect(body.left?.sha256).toBe(body.right?.sha256);
  });

  it('supports a single side', async () => {
    const res = await get({ left: p('left', 'only-left.txt') });
    expect(res.statusCode).toBe(200);
    const body = res.json<FileCompareResult>();
    expect(body.left?.content).toBe('L');
    expect(body.right).toBeUndefined();
    expect(body.identical).toBe(false);
  });

  it('does not return content for binary files', async () => {
    const body = (await get({ left: p('bin.dat') })).json<FileCompareResult>();
    expect(body.left?.binary).toBe(true);
    expect(body.left?.content).toBeUndefined();
    expect(body.left?.size).toBe(5);
  });

  it('does not return content for text files over the size limit', async () => {
    const body = (await get({ left: p('big.txt') })).json<FileCompareResult>();
    expect(body.left?.tooLarge).toBe(true);
    expect(body.left?.content).toBeUndefined();
  });

  it('returns 400 when no path is given', async () => {
    expect((await get({})).statusCode).toBe(400);
  });

  it('returns 404 for a missing file', async () => {
    const res = await get({ left: p('missing.txt') });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ message: string }>().message).toContain('missing.txt');
  });

  it('returns 400 when the path is a directory', async () => {
    expect((await get({ left: p('left') })).statusCode).toBe(400);
  });
});
