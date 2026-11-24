import type { GitRefs } from '@om/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { gitRefs } from './api.ts';

/**
 * Every branch and tag of every remote of one repo, for a picker. Shares its cache across pages that list the
 * same repo's refs. Off until `enabled` (the repo must be in the session first).
 */
export function useRepoRefs(
  user: string,
  sessionId: string,
  repoId: string,
  enabled: boolean,
): UseQueryResult<GitRefs> {
  return useQuery({
    queryKey: ['git-refs', user, sessionId, repoId, ''] as const,
    queryFn: ({ signal }) => gitRefs({ user, sessionId, repoId }, signal),
    enabled,
  });
}
