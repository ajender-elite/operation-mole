import type { CommitPatch, GitAncestry, GitMergeTree, GitPatchEquivalents } from '@om/shared';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler, USER } from '../test/handlers.ts';
import { server } from '../test/server.ts';
import { loadApplicability, conflictExcerpts } from './applicability.ts';
import type { UpstreamPair } from './upstream.ts';

/*
 * Applicability of one upstream commit to the downstream snapshot, composed in the browser from git
 * primitives. Each commit is evaluated on its own against the same downstream commit, and nothing is
 * claimed beyond what git shows: a conflict is not "missing", and a clean apply is not "safe".
 */

const UP = 'a'.repeat(40);
const DOWN = 'd'.repeat(40);
const BASE = 'e'.repeat(40);
const COMMIT = 'c'.repeat(40);
const EQUIVALENT = 'f'.repeat(40);

const pinned: UpstreamPair = {
  user: USER,
  sessionId: 's1',
  upstream: { type: 'git', repoId: 'r1', branch: UP },
  downstream: { type: 'git', repoId: 'r1', branch: DOWN },
};

const patch = (files: CommitPatch['files']): CommitPatch => ({
  commit: COMMIT,
  details: {
    sha: COMMIT,
    subject: 'Add the feature',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-01-02T00:00:00Z',
    committerName: 'Ada',
    committerEmail: 'ada@example.com',
    commitDate: '2026-01-02T00:00:00Z',
    parents: [BASE],
  },
  baseParent: BASE,
  files,
  truncated: false,
});

const added = { newPath: 'feature.txt', status: 'added' as const, binary: false, hunks: [] };

const merge = (over: Partial<GitMergeTree>): GitMergeTree => ({
  ours: { commit: DOWN, ref: 'product', label: 'app @ product' },
  theirs: { commit: COMMIT, ref: 'main', label: 'app @ main' },
  base: BASE,
  isClean: true,
  conflictedPaths: [],
  conflictedFiles: [],
  changedPaths: [],
  messages: [],
  ...over,
});

/** The answers git would give for one commit, set per test. */
type Scenario = {
  isReachable: boolean;
  patch: CommitPatch;
  merge: GitMergeTree;
  equivalents?: GitPatchEquivalents;
};

function answer(scenario: Scenario): void {
  server.use(
    sessionDetailHandler({ repos: [repoInfo({ branches: ['main', 'product'] })] }),
    http.post('*/api/git/show', () => HttpResponse.json(scenario.patch)),
    http.post('*/api/git/ancestry', async ({ request }) => {
      const body = (await request.json()) as { commits: string[] };
      return HttpResponse.json<GitAncestry>({
        results: body.commits.map((c) => ({ commit: c, isAncestor: scenario.isReachable })),
      });
    }),
    http.post('*/api/git/merge-tree', () => HttpResponse.json(scenario.merge)),
    http.post('*/api/git/patch-equivalents', () =>
      HttpResponse.json(
        scenario.equivalents ?? {
          left: { commit: DOWN, ref: 'product', label: 'app @ product' },
          right: { commit: COMMIT, ref: 'main', label: 'app @ main' },
          commits: [],
        },
      ),
    ),
  );
}

beforeEach(() => {
  server.resetHandlers();
});

describe('loadApplicability', () => {
  it('is represented by reachability when downstream already has the commit', async () => {
    answer({ isReachable: true, patch: patch([added]), merge: merge({}) });
    const result = await loadApplicability(pinned, COMMIT, undefined);
    expect(result).toMatchObject({ status: 'represented', reason: 'reachable' });
    expect(result.files).toEqual([{ path: 'feature.txt', outcome: 'already-present' }]);
  });

  it('applies cleanly when the merge changes downstream', async () => {
    answer({
      isReachable: false,
      patch: patch([added]),
      merge: merge({ changedPaths: ['feature.txt'] }),
    });
    const result = await loadApplicability(pinned, COMMIT, undefined);
    expect(result).toMatchObject({ status: 'clean', reason: 'applies' });
    expect(result.files).toEqual([{ path: 'feature.txt', outcome: 'applies' }]);
  });

  it('reports a conflict with excerpts, and does not call the change missing', async () => {
    const conflicted = 'x\n<<<<<<< ours\ntheirs\n=======\nours\n>>>>>>> theirs\n';
    answer({
      isReachable: false,
      patch: patch([{ ...added, newPath: 'shared.txt' }]),
      merge: merge({
        isClean: false,
        conflictedPaths: ['shared.txt'],
        conflictedFiles: [{ path: 'shared.txt', text: conflicted }],
        messages: ['CONFLICT (content): Merge conflict in shared.txt'],
      }),
    });
    const result = await loadApplicability(pinned, COMMIT, undefined);
    expect(result).toMatchObject({ status: 'conflict', reason: 'conflict' });
    expect(result.files).toEqual([{ path: 'shared.txt', outcome: 'conflict' }]);
    expect(result.conflicts[0]).toMatchObject({ path: 'shared.txt', startLine: 1 });
    expect(result.messages).toEqual(['CONFLICT (content): Merge conflict in shared.txt']);
  });

  it('is represented by an equivalent downstream commit when the merge changes nothing', async () => {
    answer({
      isReachable: false,
      patch: patch([added]),
      merge: merge({ changedPaths: [] }),
      equivalents: {
        left: { commit: DOWN, ref: 'product', label: 'app @ product' },
        right: { commit: COMMIT, ref: 'main', label: 'app @ main' },
        commits: [
          {
            commit: {
              sha: EQUIVALENT,
              subject: 'Add the feature (cherry-picked)',
              authorName: 'Bob',
              authorEmail: 'b@example.com',
              authorDate: '2026-01-03T00:00:00Z',
              committerName: 'Bob',
              committerEmail: 'b@example.com',
              commitDate: '2026-01-03T00:00:00Z',
              parents: [],
            },
            mark: 'equivalent',
          },
          {
            commit: {
              sha: COMMIT,
              subject: 'Add the feature',
              authorName: 'Ada',
              authorEmail: 'ada@example.com',
              authorDate: '2026-01-02T00:00:00Z',
              committerName: 'Ada',
              committerEmail: 'ada@example.com',
              commitDate: '2026-01-02T00:00:00Z',
              parents: [BASE],
            },
            mark: 'equivalent',
          },
        ],
      },
    });
    const result = await loadApplicability(pinned, COMMIT, undefined);
    expect(result).toMatchObject({ status: 'represented', reason: 'equivalent-patch' });
    expect(result.equivalentCommits.map((c) => c.sha)).toEqual([EQUIVALENT]);
  });
});

describe('conflictExcerpts', () => {
  it('shows each conflict region with a little context, with line numbers', () => {
    const text = ['a', 'b', 'c', '<<<<<<< ours', 'x', '=======', 'y', '>>>>>>> theirs', 'd'].join(
      '\n',
    );
    const [excerpt] = conflictExcerpts('f.txt', text);
    expect(excerpt).toEqual({ path: 'f.txt', startLine: 1, lines: text.split('\n') });
  });
});
