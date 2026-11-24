import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { UsernameSchema } from '@om/shared';
import { CompareInputError } from '../errors.ts';
import { Store, type StoreOptions } from './store.ts';

/** How many users' database files stay open at once; the least recently used is closed. */
const MAX_OPEN = 32;

/** Where one user's database lives: `<dataDir>/users/<user>/user.db`. */
export function userDatabasePath(dataDir: string, user: string): string {
  const parsed = UsernameSchema.safeParse(user);
  if (!parsed.success) throw new CompareInputError(`Invalid user name: ${user}`);
  return path.join(dataDir, 'users', parsed.data, 'user.db');
}

/**
 * Opens each user's database on demand. A user exists when their file does; reads for a user who
 * has none see an empty account, and nothing is created for them.
 */
export class StoreRegistry {
  readonly #dataDir: string;
  readonly #options: StoreOptions;
  /** Open databases, least recently used first. */
  readonly #open = new Map<string, Store>();

  constructor(dataDir: string, options: StoreOptions = {}) {
    this.#dataDir = dataDir;
    this.#options = options;
  }

  /** The user's database if it exists (a read): `undefined` for a user who has none. */
  read(user: string): Store | undefined {
    const file = userDatabasePath(this.#dataDir, user);
    if (!existsSync(file)) return undefined;
    return this.#openFile(user, file);
  }

  /** The user's database, created on first use (a write). */
  write(user: string): Store {
    const file = userDatabasePath(this.#dataDir, user);
    mkdirSync(path.dirname(file), { recursive: true });
    return this.#openFile(user, file);
  }

  #openFile(user: string, file: string): Store {
    const cached = this.#open.get(user);
    if (cached !== undefined) {
      // Touch: move it to the most-recent end.
      this.#open.delete(user);
      this.#open.set(user, cached);
      return cached;
    }
    const store = new Store(file, this.#options);
    this.#open.set(user, store);
    while (this.#open.size > MAX_OPEN) {
      const [oldest, oldestStore] = this.#open.entries().next().value ?? [];
      if (oldest === undefined || oldestStore === undefined) break;
      this.#open.delete(oldest);
      oldestStore.close();
    }
    return store;
  }

  /** Closes every open database. */
  close(): void {
    for (const store of this.#open.values()) store.close();
    this.#open.clear();
  }
}
