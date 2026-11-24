import type { GitCherryPick } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { gitCherryPick, gitRefs } from '../lib/api.ts';
import { findPickedAs, type PickedAs } from '../lib/picked-as.ts';
import { usePooledQueries } from '../lib/pooled-queries.ts';
import { useSessionParams } from '../lib/session.ts';
import { Loading, Notice } from './notice.tsx';
import { SeriesVerdict } from './series-verdict.tsx';
import { CHECKS_AT_ONCE } from '../lib/series-checks.ts';

/**
 * The Branches pane of a commit: whether this one commit would apply on each branch of each remote, checked
 * as a one-pick series (`cherry-pick`). A branch that already has the commit says so; the checks run a few
 * at a time, and a branch's result is kept, so opening the commit again is instant. The same check as the
 * Series tab, so both share their cached results.
 */
export function CommitBranches({
  repoId,
  sha,
  parent,
}: {
  repoId: string;
  sha: string;
  /** The commit's first parent: bounds the search for the same change on each branch (none for a root). */
  parent: string | undefined;
}): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const refs = useQuery({
    queryKey: ['git-refs', user, sessionId, repoId, 'commit-branches'] as const,
    queryFn: ({ signal }) => gitRefs({ user, sessionId, repoId }, signal),
  });
  const branches = (refs.data?.refs ?? []).filter((ref) => ref.kind === 'branch');
  const checks = usePooledQueries<GitCherryPick>(
    branches.map((ref) => {
      const queryKey = ['git-cherry-pick', user, sessionId, repoId, ref.remote, ref.name, [sha]];
      return {
        id: `${ref.remote}/${ref.name}`,
        queryKey,
        run: (client) =>
          client.query({
            queryKey,
            queryFn: ({ signal }) =>
              gitCherryPick(
                {
                  user,
                  sessionId,
                  onto: { type: 'git', repoId, remote: ref.remote, branch: ref.name },
                  commits: [sha],
                },
                signal,
              ),
            staleTime: Infinity,
          }),
      };
    }),
    refs.isSuccess,
    CHECKS_AT_ONCE,
  );
  // The same change already on a branch, as another commit. Its own pool, so it does not wait on the checks.
  // A search that fails leaves the verdict as it is: the check above still says what would happen.
  const picked = usePooledQueries<PickedAs | null>(
    branches.map((ref) => {
      const queryKey = [
        'git-picked-as',
        user,
        sessionId,
        repoId,
        ref.remote,
        ref.name,
        sha,
        parent ?? '',
      ];
      return {
        id: `${ref.remote}/${ref.name}`,
        queryKey,
        run: (client) =>
          client.query({
            queryKey,
            queryFn: ({ signal }) =>
              findPickedAs(
                {
                  user,
                  sessionId,
                  repoId,
                  onto: { remote: ref.remote, branch: ref.name },
                  sha,
                  parent,
                },
                signal,
              ),
            staleTime: Infinity,
          }),
      };
    }),
    refs.isSuccess,
    CHECKS_AT_ONCE,
  );

  if (refs.isError) return <Notice tone="error">{refs.error.message}</Notice>;
  if (!refs.data) return <Loading label="Loading branches…" />;
  if (branches.length === 0) return <Notice>No branches to check on. Fetch the repo first.</Notice>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Would this commit apply on each branch? Each check is the commit as a one-pick series.
      </p>
      {branches.map((ref) => {
        const id = `${ref.remote}/${ref.name}`;
        const data = checks.results.find((r) => r.id === id)?.data;
        const error = checks.errors.find((r) => r.id === id)?.message;
        return (
          <SeriesVerdict
            key={id}
            heading={id}
            data={data}
            error={error}
            isPending={data === undefined && error === undefined}
            pickedAs={picked.results.find((r) => r.id === id)?.data}
          />
        );
      })}
    </div>
  );
}
