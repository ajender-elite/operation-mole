import type { StoreRegistry } from '../store/store-registry.ts';
import type { CacheScope, CacheStorage } from './analysis-cache.ts';

/**
 * Keeps results in each user's database (the `analysis_cache` table), so they survive a restart.
 * Each user's results are capped at `maxBytes` in total.
 */
export class StoreCacheStorage implements CacheStorage {
  readonly #stores: StoreRegistry;
  readonly #maxBytes: number;

  constructor(stores: StoreRegistry, maxBytes: number) {
    this.#stores = stores;
    this.#maxBytes = maxBytes;
  }

  get(scope: CacheScope, key: string): string | undefined {
    return this.#stores.read(scope.user)?.cacheGet(scope.repoId, key);
  }

  put(scope: CacheScope, key: string, json: string): void {
    this.#stores.write(scope.user).cachePut(scope.repoId, key, json, this.#maxBytes);
  }

  purgeRepo(scope: CacheScope): void {
    this.#stores.read(scope.user)?.cachePurgeRepo(scope.repoId);
  }
}
