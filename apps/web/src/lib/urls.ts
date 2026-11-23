import type { GitSource } from '@om/shared';
import type { DiffTarget } from './attribution.ts';
import { sourcesSearch } from './sources.ts';

/** The pages inside a session, as URL segments. */
export type SessionPage = 'folders' | 'file' | 'upstream';

/** URL of a session, or of one of its pages. */
export function sessionPath(user: string, sessionId: string, page?: SessionPage): string {
  const base = `/u/${encodeURIComponent(user)}/s/${encodeURIComponent(sessionId)}`;
  return page ? `${base}/${page}` : base;
}

/** The Folder Compare of two snapshots. */
export function foldersUrl(
  user: string,
  sessionId: string,
  left: GitSource,
  right: GitSource,
): string {
  return `${sessionPath(user, sessionId, 'folders')}${sourcesSearch(left, right)}`;
}

/** Commit Upstream analysis of two snapshots (Base is upstream, Target downstream). */
export function upstreamUrl(
  user: string,
  sessionId: string,
  left: GitSource,
  right: GitSource,
): string {
  return `${sessionPath(user, sessionId, 'upstream')}${sourcesSearch(left, right)}`;
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
  const params = new URLSearchParams(sourcesSearch(file.left, file.right));
  params.set('leftCommit', file.leftCommit);
  params.set('rightCommit', file.rightCommit);
  if (file.target.leftPath !== undefined) params.set('leftPath', file.target.leftPath);
  if (file.target.rightPath !== undefined) params.set('rightPath', file.target.rightPath);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  return `${sessionPath(user, sessionId, 'file')}?${params}`;
}
