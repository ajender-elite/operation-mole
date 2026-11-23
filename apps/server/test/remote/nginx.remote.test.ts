import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { OmClient } from '../om-client.ts';
import { NGINX_1_26, NGINX_1_28 } from '../scenario.ts';

/*
 * REMOTE: needs the network and github.com; run with `pnpm test:remote`, never part of
 * `pnpm test`. Checks that the offline nginx fixture (seed/nginx.bundle) holds exactly the
 * trees of the pinned nginx/nginx release commits, and that OM compares them the same way
 * straight from GitHub. It pins SHAs, never a branch tip.
 */

const URL = 'https://github.com/nginx/nginx.git';
let base: string;
let app: FastifyInstance;
let om: OmClient;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-remote-nginx-'));
  app = buildApp({ dataDir: path.join(base, 'data') });
  await app.ready();
  om = await new OmClient(app, 'remote').start();
});
afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

describe('nginx/nginx', () => {
  it('has the pinned release commits, with the trees the offline fixture holds', () => {
    const dir = path.join(base, 'trees.git');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '--bare', dir]);
    git(
      'fetch',
      '-q',
      '--depth=1',
      '--filter=blob:none',
      URL,
      NGINX_1_26.upstream,
      NGINX_1_28.upstream,
    );
    expect(git('rev-parse', `${NGINX_1_26.upstream}^{tree}`)).toBe(NGINX_1_26.tree);
    expect(git('rev-parse', `${NGINX_1_28.upstream}^{tree}`)).toBe(NGINX_1_28.tree);
  });

  it('compares the release commits as the offline suite does', async () => {
    const repo = await om.addRepo(URL);
    expect(repo.branches).toEqual(expect.arrayContaining([NGINX_1_26.branch, NGINX_1_28.branch]));
    const result = await om.compare(
      om.source(repo, NGINX_1_26.upstream),
      om.source(repo, NGINX_1_28.upstream),
    );
    expect(result.summary).toEqual({
      identical: 401,
      modified: 101,
      onlyLeft: 2,
      onlyRight: 11,
      errors: 0,
    });
  });
});
