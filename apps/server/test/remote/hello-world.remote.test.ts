import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { OmClient } from '../om-client.ts';
import { SEED_BUNDLE, SEED_COMMIT, SEED_FIRST, SEED_NEWLINE } from '../scenario.ts';

/*
 * REMOTE smoke test: needs the network and github.com. Not part of `pnpm test`; run it with
 * `pnpm test:remote`. It checks that the pinned seed the offline suite uses still matches the
 * public repository, and that OM works against a real https remote. It pins SHAs, never
 * origin/master or "latest".
 */

const URL = 'https://github.com/octocat/Hello-World.git';
let base: string;
let app: FastifyInstance;
let om: OmClient;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-remote-'));
  app = buildApp({ dataDir: path.join(base, 'data') });
  await app.ready();
  om = await new OmClient(app, 'remote').start();
});
afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe('octocat/Hello-World', () => {
  it('still contains the pinned commits, identical to the offline seed bundle', async () => {
    const repo = await om.addRepo(URL);
    const result = await om.compare(om.source(repo, SEED_FIRST), om.source(repo, SEED_COMMIT));
    expect(result.rightSnapshot?.commit).toBe(SEED_COMMIT);
    const heads = execFileSync('git', ['bundle', 'list-heads', SEED_BUNDLE], { encoding: 'utf8' });
    expect(heads).toContain(SEED_COMMIT);

    const diff = await om.fileDiff({
      left: om.source(repo, SEED_FIRST),
      right: om.source(repo, SEED_COMMIT),
      leftPath: 'README',
      rightPath: 'README',
    });
    expect(diff.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'added')?.commit).toBe(
      SEED_NEWLINE,
    );
  });
});
