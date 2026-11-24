import type { CacheScope, CacheStorage } from './analysis-cache.ts';

/**
 * Results kept only in this process: nothing survives a restart. The default when no database
 * is given, and what tests use.
 */
export class MemoryCacheStorage implements CacheStorage {
  readonly #rows = new Map<string, string>();

  get(scope: CacheScope, key: string): string | undefined {
    return this.#rows.get(rowKey(scope, key));
  }

  put(scope: CacheScope, key: string, json: string): void {
    this.#rows.set(rowKey(scope, key), json);
  }

  purgeRepo(scope: CacheScope): void {
    const prefix = rowKey(scope, '');
    for (const key of [...this.#rows.keys()]) {
      if (key.startsWith(prefix)) this.#rows.delete(key);
    }
  }
}

function rowKey(scope: CacheScope, key: string): string {
  return `${scope.user}|${scope.repoId}|${key}`;
}
