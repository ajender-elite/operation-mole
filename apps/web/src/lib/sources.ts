import type { GitSource, RepoInfo } from '@om/shared';

/** One side of a comparison: `left` is Left, `right` is Right in the UI. */
export type Side = 'left' | 'right';

/**
 * A side lives in the URL as `leftRepo=<id>&leftBranch=<name>` (same for `right`), so reloads
 * and bookmarks restore the comparison. Local folders are not compared in the UI.
 */
export function sourceFromParams(params: URLSearchParams, side: Side): GitSource | undefined {
  const repoId = params.get(`${side}Repo`);
  const branch = params.get(`${side}Branch`);
  if (repoId !== null && repoId !== '' && branch !== null && branch !== '') {
    return { type: 'git', repoId, branch };
  }
  return undefined;
}

/** The `?left…&right…` query string for two git sources, in the format {@link sourceFromParams} reads. */
export function sourcesSearch(left: GitSource, right: GitSource): string {
  const params = new URLSearchParams();
  params.set('leftRepo', left.repoId);
  params.set('leftBranch', left.branch);
  params.set('rightRepo', right.repoId);
  params.set('rightBranch', right.branch);
  return `?${params}`;
}

/** Display name for a source: `repo @ branch` (`unknown repo` if the repo is gone). */
export function sourceLabel(
  source: GitSource,
  repos: Array<Pick<RepoInfo, 'id' | 'name'>>,
): string {
  const repo = repos.find((r) => r.id === source.repoId);
  return `${repo?.name ?? 'unknown repo'} @ ${source.branch}`;
}
