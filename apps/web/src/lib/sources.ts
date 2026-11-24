import { DEFAULT_REMOTE, type GitSource, type RepoInfo } from '@om/shared';

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
    const remote = params.get(`${side}Remote`);
    return {
      type: 'git',
      repoId,
      branch,
      ...(remote === null || remote === '' ? {} : { remote }),
    };
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
  // Origin is the default, so only another remote is written.
  if (left.remote !== undefined && left.remote !== DEFAULT_REMOTE)
    params.set('leftRemote', left.remote);
  if (right.remote !== undefined && right.remote !== DEFAULT_REMOTE)
    params.set('rightRemote', right.remote);
  return `?${params}`;
}

/** Display name for a source: `repo @ branch` (`unknown repo` if the repo is gone). */
export function sourceLabel(
  source: GitSource,
  repos: Array<Pick<RepoInfo, 'id' | 'name'>>,
): string {
  const repo = repos.find((r) => r.id === source.repoId);
  const remote =
    source.remote !== undefined && source.remote !== DEFAULT_REMOTE ? ` (${source.remote})` : '';
  return `${repo?.name ?? 'unknown repo'}${remote} @ ${source.branch}`;
}

/**
 * A repo and a ref in the URL: `repo=<id>`, `ref=<branch, tag or commit>`, and `remote=<name>` (origin
 * when absent). The explorer pages (Code, History, Search, Branches, Series) read their source this way.
 */
export function refSourceFromParams(params: URLSearchParams): GitSource | undefined {
  const repoId = params.get('repo');
  const branch = params.get('ref');
  const remote = params.get('remote');
  if (repoId === null || repoId === '' || branch === null || branch === '') return undefined;
  return {
    type: 'git',
    repoId,
    branch,
    ...(remote === null || remote === '' ? {} : { remote }),
  };
}

/** The query values that name a repo ref, in the format {@link refSourceFromParams} reads. */
export function refParams(source: GitSource): URLSearchParams {
  const params = new URLSearchParams({ repo: source.repoId, ref: source.branch });
  if (source.remote !== undefined) params.set('remote', source.remote);
  return params;
}
