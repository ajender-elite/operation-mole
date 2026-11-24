import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { GitContains } from '@om/shared';
import { gitContains } from './api.ts';

/**
 * The branches and tags, of every remote of the repo, that contain one commit ("Contained in"). Asked once per
 * commit; the answer stays until the page is closed (a commit's history does not change).
 */
export function useContainingRefs(
  user: string,
  sessionId: string,
  repoId: string,
  sha: string,
): UseQueryResult<GitContains> {
  return useQuery({
    queryKey: ['git-contains', user, sessionId, repoId, sha] as const,
    queryFn: ({ signal }) =>
      gitContains({ user, sessionId, source: { type: 'git', repoId, branch: sha } }, signal),
    staleTime: Infinity,
  });
}
