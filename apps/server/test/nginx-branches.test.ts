import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompareNode, FolderComparison, GitBlame, GitSource, RepoInfo } from '@om/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OmClient } from './om-client.ts';
import { NGINX_1_26, NGINX_1_28, nginxFixtureKey, nginxRepo } from './scenario.ts';

/*
 * OM on a real-world repository: nginx's stable-1.26 (Left) against stable-1.28 (Right),
 * through the API as the app uses it (session, repo, branch on each side). The pinned bundle
 * keeps this offline and exact; test/remote/ checks it against github.com/nginx/nginx.
 */

let app: FastifyInstance;
let om: OmClient;
let repo: RepoInfo;
let result: FolderComparison;

const side = (branch: string): GitSource => om.source(repo, branch);

// OM's own data for nginx is kept per machine, keyed by the bundle: the first run clones it, later
// runs reuse that clone and session. Changing the bundle changes the key, so a stale clone is never used.
const dataDir = path.join(tmpdir(), 'om-test-fixtures', `nginx-data-${nginxFixtureKey()}`);

beforeAll(async () => {
  app = buildApp({ dataDir, allowedProtocols: ['https', 'ssh', 'file'] });
  await app.ready();
  om = await new OmClient(app, 'nginx').startOrResume('nginx-fixture');
  repo = await om.addRepo(nginxRepo()); // the existing clone when there is one
  result = await om.compare(side(NGINX_1_26.branch), side(NGINX_1_28.branch));
}, 120_000); // the first run clones and checks out two nginx trees (about 1,000 files)
afterAll(async () => {
  // The data folder stays: the next run reuses it.
  await app.close();
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
    const removed = changed.filter((l) => l.kind === 'removed');
    const added = changed.filter((l) => l.kind === 'added');
    // Attribution is asked of git blame on each side's own lines (the diff itself carries none).
    const left = await blameLines(
      side(NGINX_1_26.branch),
      nginxH.leftPath,
      removed.map((l) => l.leftLine ?? 0),
    );
    const right = await blameLines(
      side(NGINX_1_28.branch),
      nginxH.rightPath,
      added.map((l) => l.rightLine ?? 0),
    );
    expect(removed.map((l) => left.get(l.leftLine ?? 0))).toEqual([
      NGINX_1_26.commit,
      NGINX_1_26.commit,
    ]);
    expect(added.map((l) => right.get(l.rightLine ?? 0))).toEqual([
      NGINX_1_28.commit,
      NGINX_1_28.commit,
    ]);
  });
});

/** Line number → the commit git blame gives it, for the given lines of a file at one side's commit. */
async function blameLines(
  source: GitSource,
  path: string,
  lines: number[],
): Promise<Map<number, string>> {
  const res = await om.inject('/api/git/blame', {
    user: om.user,
    sessionId: om.sessionId,
    source,
    path,
    lines,
  });
  expect(res.statusCode, res.body).toBe(200);
  return new Map(res.json<GitBlame>().lines.map((l) => [l.line, l.commit]));
}

describe('nginx fixture', () => {
  it('is built once and reused by later calls', async () => {
    const first = nginxRepo();
    const head = path.join(fileURLToPath(first), 'HEAD');
    const before = (await stat(head)).mtimeMs;
    expect(nginxRepo()).toBe(first);
    expect((await stat(head)).mtimeMs).toBe(before);
  });
});
