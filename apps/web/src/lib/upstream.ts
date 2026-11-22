import type { ApplicabilityResult, GitSource, UpstreamCommitList } from '@om/shared';
import { queryOptions } from '@tanstack/react-query';
import { applicability, commitPatch, upstreamCommits } from './api.ts';

/** Upstream (Base, `left`) and downstream (Target, `right`) git snapshots in a session. */
export type UpstreamPair = {
  user: string;
  sessionId: string;
  upstream: GitSource;
  downstream: GitSource;
};

/** Which upstream commits to examine. */
export type CommitWindow = {
  limit: number;
  /** `YYYY-MM-DD`, or undefined for no date limit. */
  since: string | undefined;
  hideReachable: boolean;
  firstParent: boolean;
};

/** The upstream commit window (`POST /api/upstream/commits`). */
export function commitsQuery(
  pair: UpstreamPair,
  window: CommitWindow,
): ReturnType<typeof buildCommitsQuery> {
  return buildCommitsQuery(pair, window);
}

const buildCommitsQuery = (pair: UpstreamPair, window: CommitWindow) =>
  queryOptions({
    queryKey: ['upstream-commits', pair, window] as const,
    queryFn: ({ signal }): Promise<UpstreamCommitList> =>
      upstreamCommits(
        {
          ...pair,
          limit: window.limit,
          ...(window.since === undefined ? {} : { since: window.since }),
          hideReachable: window.hideReachable,
          firstParent: window.firstParent,
        },
        signal,
      ),
    staleTime: Infinity,
  });

/**
 * Both snapshots pinned to the commits the window was computed for, so every applicability
 * result is about that exact downstream state (and cacheable by SHA).
 */
export function pinnedPair(pair: UpstreamPair, list: UpstreamCommitList): UpstreamPair {
  return {
    ...pair,
    upstream: { ...pair.upstream, branch: list.upstream.commit },
    downstream: { ...pair.downstream, branch: list.downstream.commit },
  };
}

/** Applicability of one commit to the (pinned) downstream snapshot. */
export function applicabilityQuery(
  pinned: UpstreamPair,
  commit: string,
): ReturnType<typeof buildApplicabilityQuery> {
  return buildApplicabilityQuery(pinned, commit);
}

const buildApplicabilityQuery = (pinned: UpstreamPair, commit: string) =>
  queryOptions({
    queryKey: [
      'applicability',
      pinned.user,
      pinned.sessionId,
      pinned.upstream,
      pinned.downstream,
      commit,
    ] as const,
    queryFn: ({ signal }): Promise<ApplicabilityResult> =>
      applicability({ ...pinned, commit }, signal),
    staleTime: Infinity,
  });

/** A commit's patch against its first parent. */
export function patchQuery(
  pinned: UpstreamPair,
  commit: string,
): ReturnType<typeof buildPatchQuery> {
  return buildPatchQuery(pinned, commit);
}

const buildPatchQuery = (pinned: UpstreamPair, commit: string) =>
  queryOptions({
    queryKey: [
      'commit-patch',
      pinned.user,
      pinned.sessionId,
      pinned.upstream.repoId,
      commit,
    ] as const,
    queryFn: ({ signal }) =>
      commitPatch(
        { user: pinned.user, sessionId: pinned.sessionId, upstream: pinned.upstream, commit },
        signal,
      ),
    staleTime: Infinity,
  });
