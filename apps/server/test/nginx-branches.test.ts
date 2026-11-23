import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompareNode, DirectoryCompareResult, GitSource, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { NGINX_1_26, NGINX_1_28, nginxRepo } from './scenario.ts';

/*
 * OM on a real-world repository: nginx's stable-1.26 (Base) against stable-1.28 (Target),
 * through the API as the app uses it (session, repo, branch on each side). The pinned bundle
 * keeps this offline and exact; test/remote/ checks it against github.com/nginx/nginx.
 */

let base: string;
let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
let result: DirectoryCompareResult;

const side = (branch: string): GitSource => om.source(repo, branch);

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-nginx-'));
  const url = nginxRepo(path.join(base, 'nginx.git'));
  app = buildApp({ dataDir: path.join(base, 'data'), allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'nginx').start();
  repo = await om.addRepo(url);
  result = await om.compare(side(NGINX_1_26.branch), side(NGINX_1_28.branch));
}, 120_000); // clones and checks out two nginx trees (about 1,000 files); 30s is too tight under load
afterAll(async () => {
  await app.close();
  // Windows can hold a just-closed git file open for a moment: retry instead of failing.
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

/** The node at `p`: the folder when `kind` is `dir`, else the file. */
function node(p: string, kind: 'dir' | 'file' = 'file'): CompareNode {
  let current = result.root;
  const parts = p.split('/');
  for (const [i, part] of parts.entries()) {
    const isDir = i < parts.length - 1 || kind === 'dir';
    const next = current.children?.find(
      (c) => c.name === part && (c.children !== undefined) === isDir,
    );
    if (!next) throw new Error(`no ${kind} ${p}`);
    current = next;
  }
  return current;
}

const names = (p: string) => (p === '' ? result.root : node(p, 'dir')).children?.map((c) => c.name);

describe('nginx stable-1.26 → stable-1.28', () => {
  it('lists the branches of the repository', () => {
    expect(repo.branches).toEqual(expect.arrayContaining([NGINX_1_26.branch, NGINX_1_28.branch]));
  });

  it('resolves each branch to its exact commit', () => {
    expect(result.leftSnapshot).toEqual({ commit: NGINX_1_26.commit, ref: NGINX_1_26.branch });
    expect(result.rightSnapshot).toEqual({ commit: NGINX_1_28.commit, ref: NGINX_1_28.branch });
  });

  it('counts every file by status', () => {
    expect(result.root.status).toBe('modified');
    expect(result.summary).toEqual({
      identical: 401,
      modified: 101,
      onlyLeft: 2,
      onlyRight: 11,
      errors: 0,
    });
  });

  it.each<[string, CompareNode['status'], ('dir' | 'file')?]>([
    // changed between the releases
    ['src/core/nginx.h', 'modified'],
    ['LICENSE', 'modified'],
    ['src', 'modified', 'dir'],
    ['src/core', 'modified', 'dir'],
    // removed in 1.28
    ['README', 'only-left'],
    ['.hgtags', 'only-left'],
    // added in 1.28
    ['README.md', 'only-right'],
    ['SECURITY.md', 'only-right'],
    ['src/event/ngx_event_openssl_cache.c', 'only-right'],
    ['.github', 'only-right', 'dir'],
    ['.github/workflows/buildbot.yml', 'only-right'],
    // the same in both
    ['contrib', 'identical', 'dir'],
    ['contrib/vim/syntax', 'identical', 'dir'],
    ['auto/os', 'identical', 'dir'],
    ['docs/dtd', 'identical', 'dir'],
  ])('%s is %s', (p, status, kind) => {
    expect(node(p, kind).status).toBe(status);
  });

  it('puts folders first, then files, in natural order, interleaving both sides', () => {
    expect(names('')).toEqual([
      '.github',
      'auto',
      'conf',
      'contrib',
      'docs',
      'misc',
      'src',
      '.gitignore',
      '.hgtags',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'LICENSE',
      'README',
      'README.md',
      'SECURITY.md',
    ]);
  });

  it('ignores .git at the root of each side', () => {
    expect(names('')).not.toContain('.git');
  });
});

describe('a file diff between the nginx branches', () => {
  const nginxH = {
    leftPath: 'src/core/nginx.h',
    rightPath: 'src/core/nginx.h',
  };

  it('shows the version change as one hunk', async () => {
    const diff = await om.fileDiff({
      left: side(NGINX_1_26.branch),
      right: side(NGINX_1_28.branch),
      ...nginxH,
      attribute: false,
    });
    expect(diff).toMatchObject({ leftCommit: NGINX_1_26.commit, rightCommit: NGINX_1_28.commit });
    expect(diff.hunks).toHaveLength(1);
    const changed = diff.hunks[0]?.lines.filter((l) => l.kind !== 'context');
    expect(changed?.map((l) => `${l.kind} ${l.text}`)).toEqual([
      'removed #define nginx_version      1026003',
      'removed #define NGINX_VERSION      "1.26.3"',
      'added #define nginx_version      1028003',
      'added #define NGINX_VERSION      "1.28.3"',
    ]);
    expect(changed?.every((l) => l.commit === undefined)).toBe(true);
    expect(diff.commits).toEqual([]);
  });

  it('attributes the changed lines to the commit on each side, on request', async () => {
    const diff = await om.fileDiff({
      left: side(NGINX_1_26.branch),
      right: side(NGINX_1_28.branch),
      ...nginxH,
    });
    const changed = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
    expect(changed.filter((l) => l.kind === 'removed').map((l) => l.commit)).toEqual([
      NGINX_1_26.commit,
      NGINX_1_26.commit,
    ]);
    expect(changed.filter((l) => l.kind === 'added').map((l) => l.commit)).toEqual([
      NGINX_1_28.commit,
      NGINX_1_28.commit,
    ]);
    expect(diff.commits.map((c) => c.sha).sort()).toEqual(
      [NGINX_1_26.commit, NGINX_1_28.commit].sort(),
    );
  });
});
