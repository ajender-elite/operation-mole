import { gitLog, gitPatchEquivalents } from './api.ts';

/**
 * A commit on a branch that carries the same change as the one checked. `patch`: the same change under another
 * commit id (git's patch id matches). `trailer`: the branch's commit says it picked this one (`git cherry-pick -x`
 * writes `(cherry picked from commit <sha>)`), even when the change was edited afterwards.
 */
export type PickedAs = { sha: string; subject: string; how: 'patch' | 'trailer' };

/** What to look for: `sha` on the branch `onto`, bounded by its `parent` (undefined for a root commit). */
export type PickedAsRequest = {
  user: string;
  sessionId: string;
  repoId: string;
  onto: { remote: string; branch: string };
  sha: string;
  parent: string | undefined;
};

/** The newest commits of the branch that are compared by patch (git's `--cherry-mark` reads each one's patch). */
const SEARCH_LIMIT = 200;
/** The newest commits that mention the checked commit's SHA, whose messages are read for the `-x` trailer. */
const MESSAGE_LIMIT = 20;

/**
 * The commit on `onto` that already carries the same change as `sha`, if there is one. Two searches, in order:
 *
 * 1. By patch: `log --cherry-mark` between the commit alone (bounded by its parent, so only its own change is
 *    compared) and the branch. A match is a commit on the branch, other than `sha`, marked equal.
 * 2. By message: a commit on the branch whose message says `(cherry picked from commit <sha>)`.
 *
 * Null when neither finds one, and for a root commit (its parent is what bounds the first search). Only the
 * newest {@link SEARCH_LIMIT} commits are compared by patch, and the newest {@link MESSAGE_LIMIT} by message.
 */
export async function findPickedAs(
  request: PickedAsRequest,
  signal?: AbortSignal,
): Promise<PickedAs | null> {
  const { user, sessionId, repoId, onto, sha, parent } = request;
  if (parent === undefined) return null;
  const branch = { type: 'git' as const, repoId, remote: onto.remote, branch: onto.branch };

  const result = await gitPatchEquivalents(
    {
      user,
      sessionId,
      left: branch,
      right: { type: 'git', repoId, branch: sha },
      exclude: { type: 'git', repoId, branch: parent },
      limit: SEARCH_LIMIT,
    },
    signal,
  );
  const match = result.commits.find((c) => c.mark === 'equivalent' && c.commit.sha !== sha);
  if (match !== undefined) {
    return { sha: match.commit.sha, subject: match.commit.subject, how: 'patch' };
  }

  const log = await gitLog(
    {
      user,
      sessionId,
      source: branch,
      grep: sha,
      withBody: true,
      limit: MESSAGE_LIMIT,
    },
    signal,
  );
  const noted = log.commits.find(
    (c) => c.sha !== sha && (c.body ?? '').includes(`cherry picked from commit ${sha}`),
  );
  return noted === undefined ? null : { sha: noted.sha, subject: noted.subject, how: 'trailer' };
}
