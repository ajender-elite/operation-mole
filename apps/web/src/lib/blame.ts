import type { CommitInfo, GitAncestry, GitBlame, GitSource } from '@om/shared';
import { queryOptions } from '@tanstack/react-query';
import { gitAncestry, gitBlame } from './api.ts';

/** The commit that last changed one line of a side, as the view shows it. */
export type BlameMark = {
  sha: string;
  subject: string;
  authorName: string;
  authorDate: string;
  /** The other side's history has this commit too, so it is shared rather than the side's own change. */
  isShared: boolean;
};

/**
 * Each blamed line of a side, by line number, with its commit. A line whose commit is missing from
 * `commits` keeps its sha, with no subject.
 */
export function blameMarks(blame: GitBlame, shared: ReadonlySet<string>): Map<number, BlameMark> {
  const info = new Map<string, CommitInfo>(blame.commits.map((c) => [c.sha, c]));
  return new Map(
    blame.lines.map((line): [number, BlameMark] => {
      const commit = info.get(line.commit);
      return [
        line.line,
        {
          sha: line.commit,
          subject: commit?.subject ?? '',
          authorName: commit?.authorName ?? '',
          authorDate: commit?.authorDate ?? '',
          isShared: shared.has(line.commit),
        },
      ];
    }),
  );
}

/** The blame of a whole file at one side's commit (`POST /api/git/blame`). */
export function blameQuery(
  user: string,
  sessionId: string,
  source: GitSource,
  path: string,
): ReturnType<typeof buildBlameQuery> {
  return buildBlameQuery(user, sessionId, source, path);
}

const buildBlameQuery = (user: string, sessionId: string, source: GitSource, path: string) =>
  queryOptions({
    queryKey: ['blame', user, sessionId, source, path],
    queryFn: ({ signal }) => gitBlame({ user, sessionId, source, path }, signal),
  });

/** Whether each commit is in `tip`'s history (`POST /api/git/ancestry`, at most 200 commits). */
export function ancestryQuery(
  user: string,
  sessionId: string,
  tip: GitSource,
  commits: readonly string[],
): ReturnType<typeof buildAncestryQuery> {
  return buildAncestryQuery(user, sessionId, tip, commits);
}

const buildAncestryQuery = (
  user: string,
  sessionId: string,
  tip: GitSource,
  commits: readonly string[],
) =>
  queryOptions({
    queryKey: ['ancestry', user, sessionId, tip, commits],
    queryFn: ({ signal }) => gitAncestry({ user, sessionId, tip, commits: [...commits] }, signal),
  });

/** The commits the answer says are in the other side's history. */
export function sharedWith(ancestry: GitAncestry | undefined): Set<string> {
  return new Set(
    (ancestry?.results ?? []).flatMap((r) => (r.isAncestor === true ? [r.commit] : [])),
  );
}
