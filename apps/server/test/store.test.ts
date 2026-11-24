import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/errors.ts';
import { SCHEMA_VERSION, applySchema } from '../src/store/schema.ts';
import { Store } from '../src/store/store.ts';

/*
 * One user's database (users/<user>/user.db): sessions, their repos with remotes, and the analysis cache.
 * Each test gets a fresh in-memory database, so nothing leaks between them.
 */

let store: Store;
let tick: number;

beforeEach(() => {
  tick = 0;
  // Deterministic clock: each call is one second later.
  store = new Store(':memory:', { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
});

const repoInput = (sessionId: string, url = 'https://example.com/acme/app.git') => ({
  sessionId,
  url,
  name: 'app',
  defaultBranch: 'main',
  branches: ['main', 'dev'],
});

describe('schema', () => {
  it('creates the current version, with remotes and the analysis cache', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row['name']);
    expect(tables).toEqual(
      expect.arrayContaining(['sessions', 'repos', 'remotes', 'analysis_cache']),
    );
    db.close();
  });

  it('applying the schema twice changes nothing', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    expect(() => {
      applySchema(db);
    }).not.toThrow();
    db.close();
  });

  it('refuses a database written by a newer OM rather than guessing at it', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => {
      applySchema(db);
    }).toThrow(/newer than this OM/);
    db.close();
  });
});

describe('sessions', () => {
  it('creates and lists sessions, newest activity first', () => {
    const a = store.createSession('First');
    store.createSession('Second');

    expect(a).toMatchObject({ name: 'First', repoCount: 0 });
    expect(a.id).toMatch(/^[a-z0-9-]+$/);
    expect(store.listSessions().map((s) => s.name)).toEqual(['Second', 'First']);

    store.touchSession(a.id);
    expect(store.listSessions().map((s) => s.name)).toEqual(['First', 'Second']);
  });

  it('rejects a duplicate session name, ignoring case', () => {
    store.createSession('Review');
    expect(() => store.createSession('review')).toThrow(ConflictError);
  });

  it('finds a session by id, and reports nothing for an unknown one', () => {
    const s = store.createSession('Mine');
    expect(store.getSession(s.id)?.name).toBe('Mine');
    expect(store.getSession('no-such-session')).toBeUndefined();
  });

  it('deletes a session with its repos and remotes', () => {
    const s = store.createSession('Temp');
    const repo = store.saveRepo(repoInput(s.id));
    expect(store.deleteSession('no-such-session')).toBe(false);
    expect(store.deleteSession(s.id)).toBe(true);
    expect(store.getSession(s.id)).toBeUndefined();
    expect(store.getRepo(s.id, repo.id)).toBeUndefined();
  });
});

describe('repos', () => {
  it('saves repos per session with their origin URL, and counts them', () => {
    const s = store.createSession('Repos');
    const repo = store.saveRepo(repoInput(s.id));
    expect(repo).toMatchObject({
      url: 'https://example.com/acme/app.git',
      branches: ['main', 'dev'],
    });
    expect(store.getRepo(s.id, repo.id)).toEqual(repo);
    expect(store.findRepoByUrl(s.id, 'https://example.com/acme/app.git')?.id).toBe(repo.id);
    expect(store.listSessions()[0]?.repoCount).toBe(1);
  });

  it('updates an existing repo instead of duplicating it', () => {
    const s = store.createSession('Repos');
    const first = store.saveRepo(repoInput(s.id));
    const second = store.saveRepo({
      ...repoInput(s.id),
      id: first.id,
      branches: ['main', 'dev', 'new'],
    });
    expect(second.id).toBe(first.id);
    expect(store.listRepos(s.id)).toHaveLength(1);
    expect(store.getRepo(s.id, first.id)?.branches).toEqual(['main', 'dev', 'new']);
    expect(second.fetchedAt > first.fetchedAt).toBe(true);
  });

  it('keeps repos separate between sessions', () => {
    const a = store.createSession('A');
    const b = store.createSession('B');
    const repo = store.saveRepo(repoInput(a.id));
    expect(store.getRepo(b.id, repo.id)).toBeUndefined();
    expect(store.findRepoByUrl(b.id, repo.url)).toBeUndefined();
  });
});
