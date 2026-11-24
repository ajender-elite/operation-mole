import type { GitSource } from '@om/shared';
import type { DiffTarget } from './attribution.ts';
import { refParams, sourcesSearch } from './sources.ts';

/** The pages inside a session, as URL segments. */
export type SessionPage =
  'folders' | 'file' | 'commit' | 'commits' | 'code' | 'search' | 'branches' | 'series' | 'between';

/** URL of a session, or of one of its pages. */
export function sessionPath(user: string, sessionId: string, page?: SessionPage): string {
  const base = `/u/${encodeURIComponent(user)}/s/${encodeURIComponent(sessionId)}`;
  return page ? `${base}/${page}` : base;
}

/** The Folder Compare of two snapshots, optionally opened on one folder of them (`path`). */
export function foldersUrl(
  user: string,
  sessionId: string,
  left: GitSource,
  right: GitSource,
  path?: string,
): string {
  const base = sessionPath(user, sessionId, 'folders');
  const search = new URLSearchParams(sourcesSearch(left, right).slice(1));
  if (path !== undefined && path !== '') search.set('path', path);
  return `${base}?${search}`;
}

/** Where a File Compare comes from and what it shows. */
export type FileCompareTarget = {
  /** The Folder Compare's sources (branches as the user chose them). */
  left: GitSource;
  right: GitSource;
  /** The commits that comparison resolved to: the file is compared at exactly these. */
  leftCommit: string;
  rightCommit: string;
  target: DiffTarget;
};

/**
 * The File Compare of one difference. Extra query values (e.g. `hunk`, `explain`, `commit`) are
 * added as given.
 */
export function fileUrl(
  user: string,
  sessionId: string,
  file: FileCompareTarget,
  extra: Record<string, string | undefined> = {},
): string {
  const params = pinnedParams(file);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  return `${sessionPath(user, sessionId, 'file')}?${params}`;
}

/** The query that pins a comparison to its commits and paths (what a File Compare tab is). */
function pinnedParams(file: FileCompareTarget): URLSearchParams {
  const params = new URLSearchParams(sourcesSearch(file.left, file.right));
  params.set('leftCommit', file.leftCommit);
  params.set('rightCommit', file.rightCommit);
  if (file.target.leftPath !== undefined) params.set('leftPath', file.target.leftPath);
  if (file.target.rightPath !== undefined) params.set('rightPath', file.target.rightPath);
  return params;
}

export function commitUrl(user: string, sessionId: string, repoId: string, sha: string): string {
  const params = new URLSearchParams({ repo: repoId, commit: sha });
  return `${sessionPath(user, sessionId, 'commit')}?${params}`;
}

/** What the Commits tab narrows its list to, and which commit its pane shows. */
export type CommitsOptions = {
  /** Only commits that touched this path (with `follow`, through its renames). */
  path?: string | undefined;
  follow?: boolean | undefined;
  /** Only commits whose message contains this text (case-insensitive). */
  grep?: string | undefined;
  /** Only commits whose author name or email contains this text (case-insensitive). */
  author?: string | undefined;
  /**
   * Commits reachable from the source and not from this one: a range (top down to bottom), or what the other
   * side lacks. Same repo as the source.
   */
  notIn?: GitSource | undefined;
  /** The commit whose patch the pane shows. */
  commit?: string | undefined;
};

/**
 * The Commits tab: the commits reachable from a ref (`repo`, `remote`, `ref`), newest first, narrowed by
 * the options. One tab replaces the old History, Range Log and Commit List.
 */
export function commitsUrl(
  user: string,
  sessionId: string,
  source: GitSource,
  options: CommitsOptions = {},
): string {
  const params = refParams(source);
  if (options.path !== undefined && options.path !== '') params.set('path', options.path);
  if (options.follow === true) params.set('follow', '1');
  if (options.grep !== undefined && options.grep !== '') params.set('q', options.grep);
  if (options.author !== undefined && options.author !== '') params.set('author', options.author);
  if (options.notIn !== undefined) {
    params.set('notIn', options.notIn.branch);
    if (options.notIn.remote !== undefined && options.notIn.remote !== '') {
      params.set('notInRemote', options.notIn.remote);
    }
  }
  if (options.commit !== undefined && options.commit !== '') params.set('commit', options.commit);
  return `${sessionPath(user, sessionId, 'commits')}?${params}`;
}

/** Adds the given query values to a page's URL (empty and absent values are left out). */
function pageUrl(
  user: string,
  sessionId: string,
  page: SessionPage,
  params: URLSearchParams,
  extra: Record<string, string | undefined> = {},
): string {
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const query = params.toString();
  return query === ''
    ? sessionPath(user, sessionId, page)
    : `${sessionPath(user, sessionId, page)}?${query}`;
}

/** The Code tab: a repo at a ref, showing a folder or a file (`path`), optionally with lines (`lines=10-20`). */
export function codeUrl(
  user: string,
  sessionId: string,
  source: GitSource,
  extra: Record<string, string | undefined> = {},
): string {
  return pageUrl(user, sessionId, 'code', refParams(source), extra);
}

/** The Search tab: lines of a ref that match a query. */
export function searchUrl(
  user: string,
  sessionId: string,
  source: GitSource,
  query?: string,
): string {
  return pageUrl(user, sessionId, 'search', refParams(source), { q: query });
}

/** The Branches tab: every branch and tag of every remote of a repo. */
export function branchesUrl(user: string, sessionId: string, repoId: string): string {
  return pageUrl(user, sessionId, 'branches', new URLSearchParams({ repo: repoId }));
}

/**
 * The Series tab: the commits to pick (`picks`, in order) and the branches to check them on (`onto`, each
 * as `remote/branch`, repeated).
 */
export function seriesUrl(
  user: string,
  sessionId: string,
  repoId: string,
  picks: readonly string[],
  onto: ReadonlyArray<{ remote: string; branch: string }> = [],
): string {
  const params = new URLSearchParams({ repo: repoId });
  if (picks.length > 0) params.set('picks', picks.join(','));
  for (const target of onto) params.append('onto', `${target.remote}/${target.branch}`);
  return pageUrl(user, sessionId, 'series', params);
}

/** One side of a Between comparison: a remote and a branch (or tag) on it, written `remote/branch`. */
export type RemoteRef = { remote: string; branch: string };

/**
 * The Between tab: the commits on each side of two branches that the other side does not have, with the
 * ones already picked across marked. `left` and `right` are written `remote/branch`.
 */
export function betweenUrl(
  user: string,
  sessionId: string,
  repoId: string,
  left: RemoteRef,
  right: RemoteRef,
): string {
  const params = new URLSearchParams({
    repo: repoId,
    left: `${left.remote}/${left.branch}`,
    right: `${right.remote}/${right.branch}`,
  });
  return `${sessionPath(user, sessionId, 'between')}?${params}`;
}
