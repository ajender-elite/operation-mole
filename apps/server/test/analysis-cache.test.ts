import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type CacheScope,
  type CacheStorage,
  TieredAnalysisCache,
} from '../src/cache/analysis-cache.ts';

/*
 * The analysis cache: computes a result once, serves repeats from memory or storage, shares one
 * computation among concurrent callers, keeps only results worth keeping, and never trusts a stored
 * value that no longer has the expected shape.
 */

const SCOPE: CacheScope = { user: 'ana', repoId: 'r1' };
const OTHER: CacheScope = { user: 'ana', repoId: 'r2' };
const NUMBER = z.number();

/** A storage that keeps rows in a Map, so the tests can inspect and corrupt them. */
function memoryStorage(): CacheStorage & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const rowKey = (scope: CacheScope, key: string) => `${scope.user}|${scope.repoId}|${key}`;
  return {
    rows,
    get: (scope, key) => rows.get(rowKey(scope, key)),
    put: (scope, key, json) => {
      rows.set(rowKey(scope, key), json);
    },
    purgeRepo: (scope) => {
      const prefix = `${scope.user}|${scope.repoId}|`;
      for (const key of [...rows.keys()]) {
        if (key.startsWith(prefix)) rows.delete(key);
      }
    },
  };
}

describe('TieredAnalysisCache', () => {
  it('computes a result once and serves the repeats', async () => {
    const cache = new TieredAnalysisCache(memoryStorage());
    const compute = vi.fn(() => Promise.resolve(7));
    expect(await cache.remember(SCOPE, 'k', NUMBER, compute)).toBe(7);
    expect(await cache.remember(SCOPE, 'k', NUMBER, compute)).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('shares one computation between callers that ask at the same time', async () => {
    const cache = new TieredAnalysisCache(memoryStorage());
    const compute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 3;
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.remember(SCOPE, 'k', NUMBER, compute)),
    );
    expect(results).toEqual([3, 3, 3, 3, 3]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps a result in storage, so a new cache over the same storage does not compute it', async () => {
    const storage = memoryStorage();
    await new TieredAnalysisCache(storage).remember(SCOPE, 'k', NUMBER, () => Promise.resolve(9));
    const compute = vi.fn(() => Promise.resolve(0));
    expect(await new TieredAnalysisCache(storage).remember(SCOPE, 'k', NUMBER, compute)).toBe(9);
    expect(compute).not.toHaveBeenCalled();
  });

  it('keeps only the results that are cacheable', async () => {
    const cache = new TieredAnalysisCache(memoryStorage());
    const compute = vi.fn(() => Promise.resolve<number | null>(null));
    const isCacheable = (value: number | null) => value !== null;
    const nullable = z.number().nullable();
    await cache.remember(SCOPE, 'k', nullable, compute, isCacheable);
    await cache.remember(SCOPE, 'k', nullable, compute, isCacheable);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed computation: the next call tries again', async () => {
    const cache = new TieredAnalysisCache(memoryStorage());
    const compute = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('git failed'))
      .mockResolvedValueOnce(5);
    await expect(cache.remember(SCOPE, 'k', NUMBER, compute)).rejects.toThrow('git failed');
    expect(await cache.remember(SCOPE, 'k', NUMBER, compute)).toBe(5);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('recomputes a stored value that does not have the expected shape', async () => {
    const storage = memoryStorage();
    const cache = new TieredAnalysisCache(storage);
    await cache.remember(SCOPE, 'k', NUMBER, () => Promise.resolve(1));
    for (const key of storage.rows.keys()) storage.rows.set(key, '"not a number"');
    const fresh = new TieredAnalysisCache(storage);
    expect(await fresh.remember(SCOPE, 'k', NUMBER, () => Promise.resolve(2))).toBe(2);
  });

  it('keeps different repos apart', async () => {
    const cache = new TieredAnalysisCache(memoryStorage());
    expect(await cache.remember(SCOPE, 'k', NUMBER, () => Promise.resolve(1))).toBe(1);
    expect(await cache.remember(OTHER, 'k', NUMBER, () => Promise.resolve(2))).toBe(2);
  });

  it('purges one repo from memory and storage, and leaves the others', async () => {
    const storage = memoryStorage();
    const cache = new TieredAnalysisCache(storage);
    await cache.remember(SCOPE, 'k', NUMBER, () => Promise.resolve(1));
    await cache.remember(OTHER, 'k', NUMBER, () => Promise.resolve(2));

    cache.purgeRepo(SCOPE);

    expect(storage.rows.size).toBe(1);
    const compute = vi.fn(() => Promise.resolve(11));
    expect(await cache.remember(SCOPE, 'k', NUMBER, compute)).toBe(11);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await cache.remember(OTHER, 'k', NUMBER, () => Promise.resolve(0))).toBe(2);
  });
});
