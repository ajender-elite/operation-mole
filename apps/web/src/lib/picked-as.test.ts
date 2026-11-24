import type { GitLog, GitPatchEquivalents, GitPatchEquivalentsRequest } from '@om/shared';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { commitInfo } from '../test/explore-handlers.ts';
import { server } from '../test/server.ts';
import { findPickedAs } from './picked-as.ts';

const SHA = 'd'.repeat(40);
const PARENT = 'e'.repeat(40);
const MATCH = 'f'.repeat(40);

const args = {
  user: 'karthik',
  sessionId: 's1',
  repoId: 'r1',
  onto: { remote: 'origin', branch: 'stable' },
  sha: SHA,
  parent: PARENT,
};

const equivalents = (commits: GitPatchEquivalents['commits']): GitPatchEquivalents => ({
  left: { commit: 'a'.repeat(40), ref: 'stable', label: 'app @ stable' },
  right: { commit: SHA, ref: SHA, label: 'app' },
  commits,
  truncated: false,
});

const entry = (sha: string, mark: 'left' | 'right' | 'equivalent') => ({
  commit: { ...commitInfo(sha, `Change ${sha.slice(0, 2)}`), parents: [] },
  mark,
});

/** A log of the branch's commits that mention the checked commit, with their messages. */
const logOf = (commits: Array<{ sha: string; subject: string; body: string }>): GitLog => ({
  include: { commit: 'a'.repeat(40), ref: 'stable', label: 'app @ stable' },
  commits: commits.map((c) => ({
    ...commitInfo(c.sha, c.subject),
    parents: [],
    body: c.body,
    files: [],
  })),
  hasMore: false,
  total: commits.length,
});

describe('findPickedAs', () => {
  it('finds the commit on the branch that carries the same change, by its patch', async () => {
    let sent: GitPatchEquivalentsRequest | undefined;
    server.use(
      http.post('*/api/git/patch-equivalents', async ({ request }) => {
        sent = (await request.json()) as GitPatchEquivalentsRequest;
        return HttpResponse.json(
          equivalents([
            entry(MATCH, 'equivalent'),
            entry(SHA, 'equivalent'),
            entry('1'.repeat(40), 'left'),
          ]),
        );
      }),
    );
    const picked = await findPickedAs(args);
    expect(picked).toEqual({ sha: MATCH, subject: `Change ff`, how: 'patch' });
    // The commit is compared with the branch, bounded by its parent: only the change itself is in question.
    expect(sent?.right).toEqual({ type: 'git', repoId: 'r1', branch: SHA });
    expect(sent?.exclude).toEqual({ type: 'git', repoId: 'r1', branch: PARENT });
    expect(sent?.left).toEqual({ type: 'git', repoId: 'r1', remote: 'origin', branch: 'stable' });
  });

  it('finds the commit that says it picked this one (cherry-pick -x), when the patch is not the same', async () => {
    server.use(
      http.post('*/api/git/patch-equivalents', () => HttpResponse.json(equivalents([]))),
      http.post('*/api/git/log', () =>
        HttpResponse.json(
          logOf([
            {
              sha: MATCH,
              subject: 'Backport the parser fix',
              body: `Backport the parser fix\n\n(cherry picked from commit ${SHA})\n`,
            },
          ]),
        ),
      ),
    );
    expect(await findPickedAs(args)).toEqual({
      sha: MATCH,
      subject: 'Backport the parser fix',
      how: 'trailer',
    });
  });

  it('ignores a message that only mentions another commit', async () => {
    server.use(
      http.post('*/api/git/patch-equivalents', () => HttpResponse.json(equivalents([]))),
      http.post('*/api/git/log', () =>
        HttpResponse.json(
          logOf([{ sha: MATCH, subject: 'Revert it', body: `This reverts ${'9'.repeat(40)}` }]),
        ),
      ),
    );
    expect(await findPickedAs(args)).toBeNull();
  });

  it('finds nothing when the branch has no equal change and no such message', async () => {
    server.use(
      http.post('*/api/git/patch-equivalents', () =>
        HttpResponse.json(equivalents([entry(SHA, 'right')])),
      ),
      http.post('*/api/git/log', () => HttpResponse.json(logOf([]))),
    );
    expect(await findPickedAs(args)).toBeNull();
  });

  it('does not search a root commit, which has no parent to bound the search', async () => {
    expect(await findPickedAs({ ...args, parent: undefined })).toBeNull();
  });
});
