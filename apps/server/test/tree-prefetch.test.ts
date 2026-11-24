import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/git/git-service.ts';
import type { ResolvedSnapshot } from '../src/git/repo-manager.ts';
import { prefetchTree } from '../src/git-api/trees.ts';
import { commit, createOrigin, git } from './git-fixtures.ts';

/*
 * A blob-less clone downloads, in one request, every file of a commit's tree that it lacks. The
 * top-level names come from `ls-tree --name-only -z`, one per NUL-terminated record.
 */

let base: string;
let origin: { dir: string; url: string };
let service: GitService;
let repoDir: string;
let snapshot: ResolvedSnapshot;

/** Object ids that the clone has only as promised (missing) objects, reachable from `rev`. */
const missingObjects = (rev: string): number =>
  git(repoDir, 'rev-list', '--objects', '--missing=print', rev)
    .split('\n')
    .filter((line) => line.startsWith('?')).length;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'om-prefetch-'));
  origin = createOrigin(path.join(base, 'origin'));
  // Serve partial clones, as GitHub does, so the clone below really is blob-less.
  git(origin.dir, 'config', 'uploadpack.allowFilter', 'true');
  git(origin.dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  commit(
    origin.dir,
    { 'lib/util.ts': 'export const u = 1;\n', 'docs/guide.md': 'guide\n' },
    'more',
  );

  service = new GitService({ allowedProtocols: ['https', 'ssh', 'file'] });
  repoDir = path.join(base, 'data', 'repo');
  await service.clone(origin.url, repoDir);
  snapshot = {
    repoDir,
    commit: git(origin.dir, 'rev-parse', 'main'),
    ref: 'main',
    remote: 'origin',
    label: 'origin @ main',
    cacheScope: { user: 'prefetch', repoId: 'repo' },
  };
}, 120_000);

afterAll(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

describe('prefetching a tree', () => {
  it('downloads every file of the commit that a blob-less clone lacks, in one pass', async () => {
    expect(missingObjects(snapshot.commit)).toBeGreaterThan(0);

    await prefetchTree(service, snapshot, {});

    expect(missingObjects(snapshot.commit)).toBe(0);
  }, 60_000);
});
