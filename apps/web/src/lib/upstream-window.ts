import type { UpstreamCommitList } from '@om/shared';
import { gitAncestry, gitLog, gitResolve } from './api.ts';
import type { UpstreamPair } from './upstream.ts';

/** Which upstream commits the window shows. */
export type WindowOptions = {
  limit: number;
  /** `YYYY-MM-DD`, or undefined for no date limit. */
  since: string | undefined;
  hideReachable: boolean;
  firstParent: boolean;
};

/**
 * The Upstream commit window, composed from git primitives: the two snapshots pinned to the commits
 * they name right now (`resolve`), the commits upstream has, without downstream's when they are hidden
 * (`log`, excluding downstream), and for each shown commit whether downstream already has it
 * (`ancestry`). Downstream is pinned, so every result is about that exact state.
 */
export async function loadCommitWindow(
  pair: UpstreamPair,
  options: WindowOptions,
  signal?: AbortSignal,
): Promise<UpstreamCommitList> {
  const { user, sessionId } = pair;
  const { revisions } = await gitResolve(
    { user, sessionId, sources: [pair.upstream, pair.downstream] },
    signal,
  );
  const [up, down] = revisions;
  if (up === undefined || down === undefined)
    throw new Error('The two snapshots could not be resolved');

  const upstream = { ...pair.upstream, branch: up.commit };
  const downstream = { ...pair.downstream, branch: down.commit };
  const page = await gitLog(
    {
      user,
      sessionId,
      source: upstream,
      ...(options.hideReachable ? { exclude: downstream } : {}),
      firstParent: options.firstParent,
      ...(options.since === undefined ? {} : { since: options.since }),
      limit: options.limit,
      skip: 0,
    },
    signal,
  );

  // Only the commits shown need the question asked; hidden ones are not in the window at all.
  const shas = page.commits.map((c) => c.sha);
  const history =
    options.hideReachable || shas.length === 0
      ? undefined
      : await gitAncestry({ user, sessionId, tip: downstream, commits: shas }, signal);
  const inDownstream = new Map(
    (history?.results ?? []).map((r) => [r.commit, r.isAncestor === true]),
  );

  return {
    upstream: { commit: up.commit, ref: up.ref },
    downstream: { commit: down.commit, ref: down.ref },
    upstreamLabel: up.label,
    downstreamLabel: down.label,
    commits: page.commits.map((c) => ({
      sha: c.sha,
      subject: c.subject,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      authorDate: c.authorDate,
      committerName: c.committerName,
      committerEmail: c.committerEmail,
      commitDate: c.commitDate,
      parents: c.parents,
      reachableFromDownstream: options.hideReachable ? false : inDownstream.get(c.sha) === true,
    })),
    // `total` counts the whole window, so this says whether a next page exists.
    hasMore: page.total > page.commits.length,
  };
}
