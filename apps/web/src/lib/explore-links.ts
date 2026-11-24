import type { GitSource } from '@om/shared';
import type { ExploreLink } from '../components/explore-header.tsx';
import { branchesUrl, codeUrl, commitsUrl, searchUrl, seriesUrl } from './urls.ts';

/** The explorer tabs for one repo ref. */
export type ExploreTab = 'code' | 'commits' | 'search' | 'branches' | 'series';

/**
 * The tabs an explorer page shows above it: Code, Commits, Search, Branches and Series, each for the same
 * repo (and ref where the tab is about one). `current` is the tab the page is.
 */
export function exploreLinks(
  user: string,
  sessionId: string,
  source: GitSource,
  current: ExploreTab,
): ExploreLink[] {
  return [
    { label: 'Code', url: codeUrl(user, sessionId, source), isCurrent: current === 'code' },
    {
      label: 'Commits',
      url: commitsUrl(user, sessionId, source),
      isCurrent: current === 'commits',
    },
    { label: 'Search', url: searchUrl(user, sessionId, source), isCurrent: current === 'search' },
    {
      label: 'Branches',
      url: branchesUrl(user, sessionId, source.repoId),
      isCurrent: current === 'branches',
    },
    {
      label: 'Series',
      url: seriesUrl(user, sessionId, source.repoId, []),
      isCurrent: current === 'series',
    },
  ];
}
