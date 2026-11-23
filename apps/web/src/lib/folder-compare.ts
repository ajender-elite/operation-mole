import type { DirectoryCompareResult, GitSource } from '@om/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { compareDirectories } from './api.ts';
import { sessionKey } from './session.ts';

/**
 * The comparison of two snapshots' folders. Folder Compare runs it; File Compare reads the
 * same cached result (labels, previous/next difference) instead of comparing again.
 */
export const folderCompareQuery = (
  client: QueryClient,
  user: string,
  sessionId: string,
  left: GitSource,
  right: GitSource,
): ReturnType<typeof build> => build(client, user, sessionId, left, right);

const build = (
  client: QueryClient,
  user: string,
  sessionId: string,
  left: GitSource,
  right: GitSource,
) =>
  queryOptions<DirectoryCompareResult>({
    queryKey: ['compare-directories', user, sessionId, left, right],
    queryFn: async () => {
      const result = await compareDirectories({ left, right, user, sessionId });
      // The comparison is now in the session's recent list.
      void client.invalidateQueries({ queryKey: sessionKey(user, sessionId) });
      return result;
    },
    staleTime: Infinity,
  });
