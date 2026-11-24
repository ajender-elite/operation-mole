import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/store.ts';

/*
 * The analysis cache in one user's database: results are stored per repo, read back, kept under a
 * size cap (least recently used first), and purged with the repo. A result for a repo that no longer
 * exists is dropped rather than stored.
 */

let store: Store;
let tick: number;
let sessionId: string;
let repoId: string;
let otherRepoId: string;

beforeEach(() => {
  tick = 0;
  store = new Store(':memory:', { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  sessionId = store.createSession('cache').id;
  repoId = store.saveRepo({
    sessionId,
    url: 'https://example.com/acme/app.git',
    name: 'app',
    defaultBranch: 'main',
    branches: ['main'],
  }).id;
  otherRepoId = store.saveRepo({
    sessionId,
    url: 'https://example.com/acme/lib.git',
    name: 'lib',
    defaultBranch: 'main',
    branches: ['main'],
  }).id;
});

/** A JSON text of exactly `length` characters. */
const text = (length: number) => JSON.stringify('x'.repeat(length - 2));

describe('the analysis cache in the store', () => {
  it('reads back what was put, for the same repo and key only', () => {
    store.cachePut(repoId, 'k', '"one"', 1000);
    expect(store.cacheGet(repoId, 'k')).toBe('"one"');
    expect(store.cacheGet(repoId, 'other')).toBeUndefined();
    expect(store.cacheGet(otherRepoId, 'k')).toBeUndefined();
  });

  it('replaces the value stored under the same key', () => {
    store.cachePut(repoId, 'k', '"one"', 1000);
    store.cachePut(repoId, 'k', '"two"', 1000);
    expect(store.cacheGet(repoId, 'k')).toBe('"two"');
  });

  it('keeps the total under the size cap, dropping the least recently used first', () => {
    const size = 100;
    store.cachePut(repoId, 'a', text(size), 250);
    store.cachePut(repoId, 'b', text(size), 250);
    expect(store.cacheGet(repoId, 'a')).toBeDefined(); // a is now more recent than b
    store.cachePut(repoId, 'c', text(size), 250);

    expect(store.cacheGet(repoId, 'b')).toBeUndefined();
    expect(store.cacheGet(repoId, 'a')).toBeDefined();
    expect(store.cacheGet(repoId, 'c')).toBeDefined();
  });

  it('purges one repo’s results and leaves the other repos’ results', () => {
    store.cachePut(repoId, 'k', '"mine"', 1000);
    store.cachePut(otherRepoId, 'k', '"theirs"', 1000);

    store.cachePurgeRepo(repoId);

    expect(store.cacheGet(repoId, 'k')).toBeUndefined();
    expect(store.cacheGet(otherRepoId, 'k')).toBe('"theirs"');
  });

  it('drops a result for a repo that no longer exists instead of failing', () => {
    store.deleteRepo(sessionId, repoId);
    expect(() => {
      store.cachePut(repoId, 'k', '"late"', 1000);
    }).not.toThrow();
    expect(store.cacheGet(repoId, 'k')).toBeUndefined();
  });
});
