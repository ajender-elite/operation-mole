import type { z } from 'zod';
import { LruCache } from './lru-cache.ts';

/**
 * Bump when a cached result's meaning or shape changes: entries written under another version are
 * never read, and they are the first to go when storage needs room.
 */
export const CACHE_VERSION = 2;

/** Entries kept in memory before the least recently used are dropped (storage keeps the rest). */
const DEFAULT_MEMORY_ENTRIES = 5000;

/** Which repo a result belongs to: its owner's user and the repo, so purging the repo purges it. */
export type CacheScope = { user: string; repoId: string };

/**
 * Where results persist, as JSON text. The tiered cache below uses one of these; another backend
 * (a file, a shared store) can replace the SQLite one without changing any analysis code.
 */
export type CacheStorage = {
  get(scope: CacheScope, key: string): string | undefined;
  put(scope: CacheScope, key: string, json: string): void;
  purgeRepo(scope: CacheScope): void;
};

/** Caches analysis results. `remember` computes a result once and serves the repeats. */
export type AnalysisCache = {
  remember<T>(
    scope: CacheScope,
    key: string,
    schema: z.ZodType<T>,
    compute: () => Promise<T>,
    isCacheable?: (value: T) => boolean,
  ): Promise<T>;
  purgeRepo(scope: CacheScope): void;
};

/** Parses a stored value, or undefined when it is not valid JSON of the expected shape. */
function decode<T>(schema: z.ZodType<T>, json: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A memory tier in front of a {@link CacheStorage}. Concurrent asks for one result share one
 * computation; a failed computation is not kept; a stored value of the wrong shape is recomputed.
 */
export class TieredAnalysisCache implements AnalysisCache {
  readonly #storage: CacheStorage;
  readonly #memory: LruCache<string>;
  /** Computations in progress, by full key, so concurrent asks share one. */
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(storage: CacheStorage, { memoryEntries = DEFAULT_MEMORY_ENTRIES } = {}) {
    this.#storage = storage;
    this.#memory = new LruCache(memoryEntries);
  }

  async remember<T>(
    scope: CacheScope,
    key: string,
    schema: z.ZodType<T>,
    compute: () => Promise<T>,
    isCacheable: (value: T) => boolean = () => true,
  ): Promise<T> {
    const versioned = `v${CACHE_VERSION}|${key}`;
    const fullKey = scopePrefix(scope) + versioned;

    const stored = this.#memory.get(fullKey) ?? this.#storage.get(scope, versioned);
    if (stored !== undefined) {
      const hit = decode(schema, stored);
      if (hit !== undefined) return hit;
    }

    const pending = this.#inFlight.get(fullKey);
    if (pending !== undefined) return schema.parse(await pending);

    const run = (async (): Promise<T> => {
      const value = await compute();
      if (isCacheable(value)) {
        const json = JSON.stringify(value);
        this.#memory.set(fullKey, json);
        this.#storage.put(scope, versioned, json);
      }
      return value;
    })();
    this.#inFlight.set(fullKey, run);
    try {
      return await run;
    } finally {
      if (this.#inFlight.get(fullKey) === run) this.#inFlight.delete(fullKey);
    }
  }

  purgeRepo(scope: CacheScope): void {
    const prefix = scopePrefix(scope);
    this.#memory.deleteWhere((key) => key.startsWith(prefix));
    this.#storage.purgeRepo(scope);
  }
}

/** The part of a memory key that names the repo. */
function scopePrefix(scope: CacheScope): string {
  return `${scope.user}|${scope.repoId}|`;
}
