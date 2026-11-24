import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { RemoteInfo, RepoInfo, SessionSummary } from '@om/shared';
import { z } from 'zod';
import { DEFAULT_LIMITS } from '../config/server-config.ts';
import { ConflictError } from '../errors.ts';
import { ORIGIN, applySchema } from './schema.ts';

/** What a {@link Store} needs besides its file: the clock, and how many sessions a user may hold. */
export type StoreOptions = { now?: () => Date; maxSessions?: number };

/** A cloned repo as stored: the API fields plus the session that owns it. */
export type RepoRecord = {
  sessionId: string;
} & RepoInfo;

/** What {@link Store.saveRepo} takes: a new repo, or an existing one when `id` is set. */
export type RepoInput = Omit<RepoRecord, 'id' | 'fetchedAt' | 'remotes'> & { id?: string };

/** What a remote is saved as: its name and URL, and what its last fetch found. */
export type RemoteInput = Omit<RemoteInfo, 'fetchedAt'>;

const CountRowSchema = z.object({ count: z.number() });

/** A TEXT column holding JSON, validated against `schema`. */
const jsonColumn = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((text): unknown => JSON.parse(text))
    .pipe(schema);

/*
 * Rows are parsed, not cast: SQL aliases give them the API's camelCase names, and these
 * schemas check every column, so a schema change that breaks a row fails loudly.
 */
const SessionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  repoCount: z.number(),
}) satisfies z.ZodType<SessionSummary>;

/** A repo's own columns; its remotes are read separately (see #withRemotes). */
const RepoRowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  url: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  branches: jsonColumn(z.array(z.string())),
  fetchedAt: z.string(),
}) satisfies z.ZodType<Omit<RepoRecord, 'remotes'>>;

const RemoteRowSchema = z.object({
  name: z.string(),
  url: z.string(),
  defaultBranch: z.string(),
  branches: jsonColumn(z.array(z.string())),
  fetchedAt: z.string(),
}) satisfies z.ZodType<RemoteInfo>;

const SESSION_SELECT = `
  SELECT s.id, s.name, s.created_at AS createdAt, s.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM repos r WHERE r.session_id = s.id) AS repoCount
  FROM sessions s`;

/**
 * A repo's URL and branches are those of its first remote (the clone's, kept even if it is removed later);
 * the API sees them as the repo's own.
 */
const REPO_SELECT = `
  SELECT r.id, r.session_id AS sessionId, o.url, r.name,
         o.default_branch AS defaultBranch, o.branches, o.fetched_at AS fetchedAt
  FROM repos r
  JOIN remotes o ON o.repo_id = r.id
    AND o.rowid = (SELECT MIN(p.rowid) FROM remotes p WHERE p.repo_id = r.id)`;

/**
 * One user's sessions, repos (with their remotes) in that user's own
 * SQLite file (see {@link StoreRegistry}). Nothing here needs the user's name: the file is the user.
 */
const CacheValueRowSchema = z.object({ value: z.string() });
const CacheTotalRowSchema = z.object({ total: z.number() });
const CacheOldestRowSchema = z.object({ id: z.number(), bytes: z.number() });

export class Store {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #maxSessions: number;

  constructor(path: string, options: StoreOptions = {}) {
    this.#db = new DatabaseSync(path);
    applySchema(this.#db);
    this.#now = options.now ?? (() => new Date());
    this.#maxSessions = options.maxSessions ?? DEFAULT_LIMITS.sessionsPerUser;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  /** One count of rows, read with the given parameters. */
  #count(sql: string, ...params: string[]): number {
    return CountRowSchema.parse(this.#db.prepare(sql).get(...params)).count;
  }

  /** Runs `work` in one write transaction: all of it lands, or none of it does. */
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /** A cached result's JSON text, or undefined. A hit counts as recent use (see cachePut). */
  cacheGet(repoId: string, key: string): string | undefined {
    const row = this.#db
      .prepare('SELECT value FROM analysis_cache WHERE repo_id = ? AND key = ?')
      .get(repoId, key);
    if (row === undefined) return undefined;
    this.#db
      .prepare('UPDATE analysis_cache SET last_used = ? WHERE repo_id = ? AND key = ?')
      .run(this.#timestamp(), repoId, key);
    return CacheValueRowSchema.parse(row).value;
  }

  /**
   * Stores a result for a repo, then drops the least recently used results of this user until their
   * total size is within `maxBytes`. A repo that no longer exists gets nothing: its result is dropped.
   */
  cachePut(repoId: string, key: string, json: string, maxBytes: number): void {
    const now = this.#timestamp();
    const bytes = Buffer.byteLength(json, 'utf8');
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO analysis_cache (repo_id, key, value, bytes, created_at, last_used)
           SELECT id, ?, ?, ?, ?, ? FROM repos WHERE id = ? AND true
           ON CONFLICT (repo_id, key) DO UPDATE SET
             value = excluded.value, bytes = excluded.bytes, last_used = excluded.last_used`,
        )
        .run(key, json, bytes, now, now, repoId);
      let total = CacheTotalRowSchema.parse(
        this.#db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM analysis_cache').get(),
      ).total;
      while (total > maxBytes) {
        const row = this.#db
          .prepare('SELECT rowid AS id, bytes FROM analysis_cache ORDER BY last_used ASC LIMIT 1')
          .get();
        if (row === undefined) break;
        const oldest = CacheOldestRowSchema.parse(row);
        this.#db.prepare('DELETE FROM analysis_cache WHERE rowid = ?').run(oldest.id);
        total -= oldest.bytes;
      }
    });
  }

  /** Drops every cached result of a repo. */
  cachePurgeRepo(repoId: string): void {
    this.#db.prepare('DELETE FROM analysis_cache WHERE repo_id = ?').run(repoId);
  }

  close(): void {
    this.#db.close();
  }

  listSessions(): SessionSummary[] {
    const rows = this.#db
      .prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC, s.created_at DESC`)
      .all();
    return rows.map((row) => SessionRowSchema.parse(row));
  }

  getSession(id: string): SessionSummary | undefined {
    const row = this.#db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id);
    return row === undefined ? undefined : SessionRowSchema.parse(row);
  }

  /** Creates a session, unless the user already has as many as allowed (nothing is created then). */
  createSession(name: string): SessionSummary {
    const now = this.#timestamp();
    const id = randomUUID();
    this.#transaction(() => {
      if (this.#count('SELECT COUNT(*) AS count FROM sessions') >= this.#maxSessions) {
        throw new ConflictError(
          `You already have ${this.#maxSessions} sessions. Delete one to add another.`,
        );
      }
      try {
        this.#db
          .prepare('INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(id, name, now, now);
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          throw new ConflictError(`You already have a session named "${name}"`);
        }
        throw err;
      }
    });
    const session = this.getSession(id);
    if (session === undefined) throw new Error('Session was not created');
    return session;
  }

  touchSession(id: string): void {
    this.#db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(this.#timestamp(), id);
  }

  /** Deletes a session with its repos, their remotes and cache. */
  deleteSession(id: string): boolean {
    const result = this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** How many repos a session holds (its remotes are not repos). */
  countRepos(sessionId: string): number {
    return this.#count('SELECT COUNT(*) AS count FROM repos WHERE session_id = ?', sessionId);
  }

  /** Deletes a repo, with its remotes and cache (the database cascades). */
  deleteRepo(sessionId: string, repoId: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM repos WHERE id = ? AND session_id = ?')
      .run(repoId, sessionId);
    return result.changes > 0;
  }

  /** A repo's own row with its remotes, the first one (its clone's) first. */
  #withRemotes(row: unknown): RepoRecord {
    const repo = RepoRowSchema.parse(row);
    const remotes = this.#db
      .prepare(
        `SELECT name, url, default_branch AS defaultBranch, branches, fetched_at AS fetchedAt
         FROM remotes WHERE repo_id = ? ORDER BY rowid`,
      )
      .all(repo.id)
      .map((remote) => RemoteRowSchema.parse(remote));
    return { ...repo, remotes };
  }

  listRepos(sessionId: string): RepoRecord[] {
    const rows = this.#db
      .prepare(`${REPO_SELECT} WHERE r.session_id = ? ORDER BY r.name, o.url`)
      .all(sessionId);
    return rows.map((row) => this.#withRemotes(row));
  }

  getRepo(sessionId: string, repoId: string): RepoRecord | undefined {
    const row = this.#db
      .prepare(`${REPO_SELECT} WHERE r.session_id = ? AND r.id = ?`)
      .get(sessionId, repoId);
    return row === undefined ? undefined : this.#withRemotes(row);
  }

  findRepoByUrl(sessionId: string, url: string): RepoRecord | undefined {
    const row = this.#db
      .prepare(`${REPO_SELECT} WHERE r.session_id = ? AND o.url = ?`)
      .get(sessionId, url);
    return row === undefined ? undefined : this.#withRemotes(row);
  }

  /** How many remotes a repo has. */
  countRemotes(repoId: string): number {
    return this.#count('SELECT COUNT(*) AS count FROM remotes WHERE repo_id = ?', repoId);
  }

  /**
   * Adds a remote to a repo. A name and a URL are each used once per repo; a clash is a conflict,
   * and nothing is written.
   */
  addRemote(repoId: string, input: RemoteInput): void {
    const clash = this.#db
      .prepare('SELECT name, url FROM remotes WHERE repo_id = ? AND (name = ? OR url = ?)')
      .get(repoId, input.name, input.url);
    if (clash !== undefined) {
      const { name } = z.object({ name: z.string() }).parse(clash);
      throw new ConflictError(
        name === input.name
          ? `This repository already has a remote named "${input.name}"`
          : `This repository already has that URL, as remote "${name}"`,
      );
    }
    this.#db
      .prepare(
        `INSERT INTO remotes (id, repo_id, name, url, default_branch, branches, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        repoId,
        input.name,
        input.url,
        input.defaultBranch,
        JSON.stringify(input.branches),
        this.#timestamp(),
      );
  }

  /** Records one remote's fetch: its branches and default branch, and when. */
  saveRemoteFetch(
    repoId: string,
    name: string,
    fetch: Pick<RemoteInput, 'defaultBranch' | 'branches'>,
  ): void {
    this.#db
      .prepare(
        `UPDATE remotes SET default_branch = ?, branches = ?, fetched_at = ?
         WHERE repo_id = ? AND name = ?`,
      )
      .run(fetch.defaultBranch, JSON.stringify(fetch.branches), this.#timestamp(), repoId, name);
  }

  /** Removes one remote of a repo. */
  deleteRemote(repoId: string, name: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM remotes WHERE repo_id = ? AND name = ?')
      .run(repoId, name);
    return result.changes > 0;
  }

  /** Inserts a repo, or updates it when `id` is given; its origin's `fetchedAt` is set to now. */
  saveRepo(input: RepoInput): RepoRecord {
    const id = input.id ?? randomUUID();
    const now = this.#timestamp();
    this.#db
      .prepare(
        `INSERT INTO repos (id, session_id, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
      )
      .run(id, input.sessionId, input.name, now);
    this.#db
      .prepare(
        `INSERT INTO remotes (id, repo_id, name, url, default_branch, branches, fetched_at)
         VALUES (?, ?, '${ORIGIN}', ?, ?, ?, ?)
         ON CONFLICT (repo_id, name) DO UPDATE SET
           url = excluded.url, default_branch = excluded.default_branch,
           branches = excluded.branches, fetched_at = excluded.fetched_at`,
      )
      .run(randomUUID(), id, input.url, input.defaultBranch, JSON.stringify(input.branches), now);
    const saved = this.getRepo(input.sessionId, id);
    if (saved === undefined) throw new Error('Repo was not saved');
    return saved;
  }
}
