import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/**
 * Version of one user's database (`PRAGMA user_version`). Version 2 is one file per user with
 * repos holding remotes; see docs/data-model.md for the layout and the history of versions.
 */
export const SCHEMA_VERSION = 3;

/** The name of the remote that holds a repo's URL today (until repos can have several). */
export const ORIGIN = 'origin';

const SCHEMA = `
  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (name COLLATE NOCASE)
  );
  CREATE TABLE repos (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX repos_by_session ON repos (session_id);
  CREATE TABLE remotes (
    id             TEXT PRIMARY KEY,
    repo_id        TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    url            TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    branches       TEXT NOT NULL,
    fetched_at     TEXT NOT NULL,
    UNIQUE (repo_id, name),
    UNIQUE (repo_id, url)
  );
  CREATE TABLE analysis_cache (
    repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used  TEXT NOT NULL,
    PRIMARY KEY (repo_id, key)
  );
`;

const VersionRowSchema = z.object({ user_version: z.number().int().nonnegative() });

/**
 * Brings a database to {@link SCHEMA_VERSION}, in one transaction (a failed create leaves nothing
 * behind). Refuses a database written by a newer version of OM rather than guessing at it.
 */
export function applySchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  const { user_version: version } = VersionRowSchema.parse(db.prepare('PRAGMA user_version').get());
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new Error(`Database version ${version} is newer than this OM (${SCHEMA_VERSION})`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // Version 3 dropped the recent comparisons (a version 2 file keeps everything else).
    if (version === 0) db.exec(SCHEMA);
    else db.exec('DROP TABLE IF EXISTS comparisons');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
