import type { CommitInfo, GitAncestry, GitBlame, GitDiff } from '@om/shared';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler, USER } from '../test/handlers.ts';
import { server } from '../test/server.ts';
import type { SnapshotPair } from './snapshot-diff.ts';
import { loadFileDiff } from './file-diff.ts';

/*
 * A file's attributed diff, composed in the browser from git primitives: the hunks (`diff`), the commit
 * that last changed each changed line on its own side (`blame`), and whether each such commit is in
 * each side's history (`ancestry`). Left (left) is blue and Right (right) green, as ever.
 */

const L = '1'.repeat(40);
const R = '2'.repeat(40);
const C1 = 'a'.repeat(40); // on Left only: last changed Left's line 1
const C2 = 'b'.repeat(40); // on Right only: last changed Right's line 1

const info = (sha: string, subject: string): CommitInfo => ({
  sha,
  subject,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-02T00:00:00Z',
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate: '2026-01-02T00:00:00Z',
});

const pair: SnapshotPair = {
  user: USER,
  sessionId: 's1',
  left: { type: 'git', repoId: 'r1', branch: L },
  right: { type: 'git', repoId: 'r1', branch: R },
};

let ancestryTips: string[];

beforeEach(() => {
  ancestryTips = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/diff', () =>
      HttpResponse.json<GitDiff>({
        files: [
          {
            leftCommit: L,
            rightCommit: R,
            leftPath: 'a.txt',
            rightPath: 'a.txt',
            content: 'text',
            hunks: [
              {
                header: '@@ -1 +1 @@',
                leftStart: 1,
                leftCount: 1,
                rightStart: 1,
                rightCount: 1,
                lines: [
                  { kind: 'removed', text: 'old', leftLine: 1 },
                  { kind: 'added', text: 'new', rightLine: 1 },
                ],
              },
            ],
            commits: [],
          },
        ],
      }),
    ),
    http.post('*/api/git/blame', async ({ request }) => {
      const body = (await request.json()) as { source: { branch: string } };
      const isBase = body.source.branch === L;
      return HttpResponse.json<GitBlame>({
        path: 'a.txt',
        commit: body.source.branch,
        lines: [{ line: 1, commit: isBase ? C1 : C2, origLine: 1, boundary: false }],
        commits: [info(isBase ? C1 : C2, isBase ? 'Left change' : 'Right change')],
      });
    }),
    http.post('*/api/git/ancestry', async ({ request }) => {
      const body = (await request.json()) as { tip: { branch: string }; commits: string[] };
      ancestryTips.push(body.tip.branch);
      // C1 is in Left's history only; C2 is in Right's only.
      const isIn = (commit: string, tip: string) => (tip === L ? commit === C1 : commit === C2);
      return HttpResponse.json<GitAncestry>({
        results: body.commits.map((commit) => ({
          commit,
          isAncestor: isIn(commit, body.tip.branch),
        })),
      });
    }),
  );
});

describe('loadFileDiff', () => {
  it('names the commit that last changed each changed line on its own side', async () => {
    const diff = await loadFileDiff(
      pair,
      { key: 'a.txt', leftPath: 'a.txt', rightPath: 'a.txt' },
      false,
      true,
    );
    const lines = diff.hunks[0]?.lines ?? [];
    expect(lines[0]?.commit).toBe(C1);
    expect(lines[1]?.commit).toBe(C2);
  });

  it('says which side’s history each commit is in', async () => {
    const diff = await loadFileDiff(
      pair,
      { key: 'a.txt', leftPath: 'a.txt', rightPath: 'a.txt' },
      false,
      true,
    );
    const byCommit = new Map(diff.commits.map((c) => [c.sha, c]));
    expect(byCommit.get(C1)).toMatchObject({ inLeft: true, inRight: false });
    expect(byCommit.get(C2)).toMatchObject({ inLeft: false, inRight: true });
    expect(ancestryTips.sort()).toEqual([L, R].sort());
  });

  it('skips blame and ancestry when attribution is not asked for', async () => {
    const diff = await loadFileDiff(
      pair,
      { key: 'a.txt', leftPath: 'a.txt', rightPath: 'a.txt' },
      false,
      false,
    );
    expect(diff.hunks[0]?.lines[0]?.commit).toBeUndefined();
    expect(diff.commits).toEqual([]);
    expect(ancestryTips).toEqual([]);
  });
});
