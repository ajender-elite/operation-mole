import type { FolderComparison, GitSource } from '@om/shared';
import { queryOptions } from '@tanstack/react-query';
import { gitCompareTrees } from './api.ts';

/**
 * The folder tree of two git sides' trees. Folder Compare runs it; File Compare reads the same cached
 * result (labels, previous/next difference) instead of comparing again.
 */
export const folderCompareQuery = (
  user: string,
  sessionId: string,
  left: GitSource,
  right: GitSource,
): ReturnType<typeof buildFolderCompareQuery> =>
  buildFolderCompareQuery(user, sessionId, left, right);

const buildFolderCompareQuery = (
  user: string,
  sessionId: string,
  left: GitSource,
  right: GitSource,
) =>
  queryOptions<FolderComparison>({
    queryKey: ['compare-trees', user, sessionId, left, right],
    queryFn: async ({ signal }) => {
      const trees = await gitCompareTrees({ user, sessionId, left, right }, signal);
      return trees.folder;
    },
    staleTime: Infinity,
  });
