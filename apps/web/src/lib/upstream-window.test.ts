import type { GitAncestry, GitLog, GitLogCommit, GitResolve } from '@om/shared';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler, USER } from '../test/handlers.ts';
import { server } from '../test/server.ts';
import { loadCommitWindow, type UpstreamPair } from './upstream.ts';

/*
 * The Upstream commit window, composed from git primitives: the commits upstream has (`log`), whether each
 * is already in downstream (`ancestry`), and the two snapshots it was computed for (`resolve`).
 * History: five upstream commits, the newest first; commit 4 is already in downstream.
 */

const UP = 'a'.repeat(40);
const DOWN = 'd'.repeat(40);
const sha = (n: number) => String(n).repeat(40);

const commit = (n: number): GitLogCommit => ({
  sha: sha(n),
  subject: `Upstream ${n}`,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-02T00:00:00Z',
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate: '2026-01-02T00:00:00Z',
  parents: [sha(n + 1)],
});

const history = [1, 2, 3, 4, 5].map(commit);
const reachable = new Set([sha(4)]);

const pair: UpstreamPair = {
  user: USER,
  sessionId: 's1',
  upstream: { type: 'git', repoId: 'r1', branch: 'main' },
  downstream: { type: 'git', repoId: 'r1', branch: 'product' },
};

let logBodies: Array<{ exclude?: unknown; limit: number }>;

beforeEach(() => {
  logBodies = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo({ branches: ['main', 'product'] })] }),
    http.post('*/api/git/resolve', () =>
      HttpResponse.json<GitResolve>({
        revisions: [
          { commit: UP, ref: 'main', label: 'app @ main' },
          { commit: DOWN, ref: 'product', label: 'app @ product' },
        ],
      }),
    ),
    http.post('*/api/git/log', async ({ request }) => {
      const body = (await request.json()) as { exclude?: unknown; limit: number; skip: number };
      logBodies.push(body);
      // Downstream's commits are out of the window when the window hides what downstream has.
      const range =
        body.exclude === undefined ? history : history.filter((c) => !reachable.has(c.sha));
      const page = range.slice(body.skip, body.skip + body.limit);
      return HttpResponse.json<GitLog>({
        include: { commit: UP, ref: 'main', label: 'app @ main' },
        commits: page,
        hasMore: body.skip + page.length < range.length,
        total: range.length,
      });
    }),
    http.post('*/api/git/ancestry', async ({ request }) => {
      const body = (await request.json()) as { commits: string[] };
      return HttpResponse.json<GitAncestry>({
        results: body.commits.map((c) => ({ commit: c, isAncestor: reachable.has(c) })),
      });
    }),
  );
});

describe('loadCommitWindow', () => {
  it('hides the commits downstream already has, and names both snapshots', async () => {
    const list = await loadCommitWindow(
      pair,
      { limit: 20, since: undefined, hideReachable: true, firstParent: false },
      undefined,
    );
    expect(list.commits.map((c) => c.sha)).toEqual([sha(1), sha(2), sha(3), sha(5)]);
    expect(list.commits.every((c) => !c.reachableFromDownstream)).toBe(true);
    expect(list.upstream).toEqual({ commit: UP, ref: 'main' });
    expect(list.downstreamLabel).toBe('app @ product');
    expect(logBodies[0]?.exclude).toBeDefined();
  });

  it('keeps downstream’s commits and marks the ones it already has', async () => {
    const list = await loadCommitWindow(
      pair,
      { limit: 20, since: undefined, hideReachable: false, firstParent: false },
      undefined,
    );
    const byCommit = new Map(list.commits.map((c) => [c.sha, c.reachableFromDownstream]));
    expect(byCommit.get(sha(4))).toBe(true);
    expect(byCommit.get(sha(1))).toBe(false);
    expect(logBodies[0]?.exclude).toBeUndefined();
  });

  it('reports whether there are more commits than the window shows', async () => {
    const list = await loadCommitWindow(
      pair,
      { limit: 2, since: undefined, hideReachable: false, firstParent: false },
      undefined,
    );
    expect(list.commits).toHaveLength(2);
    expect(list.hasMore).toBe(true);
  });
});
