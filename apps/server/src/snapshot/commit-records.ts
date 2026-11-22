import type { CommitInfo } from '@om/shared';

/** `git log --format` fields, unit-separated, for {@link parseCommitRecords}. Use with `-z`. */
export const COMMIT_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s'].join(
  '%x1f',
);

/** A commit as read by {@link parseCommitRecords}: metadata plus parents. */
export type CommitRecord = CommitInfo & { parents: string[] };

/** Parses `git log -z --format=<COMMIT_FORMAT>` output. */
export function parseCommitRecords(output: string): CommitRecord[] {
  return output
    .split('\0')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r !== '')
    .flatMap((record): CommitRecord[] => {
      const [sha, parents, an, ae, ad, cn, ce, cd, ...subject] = record.split('\x1f');
      if (sha === undefined || cd === undefined) return [];
      return [
        {
          sha,
          parents: (parents ?? '').split(' ').filter(Boolean),
          subject: subject.join('\x1f'),
          authorName: an ?? '',
          authorEmail: ae ?? '',
          authorDate: ad ?? '',
          committerName: cn ?? '',
          committerEmail: ce ?? '',
          commitDate: cd,
        },
      ];
    });
}

/** Commit metadata without the parents. */
export function toCommitInfo(record: CommitRecord): CommitInfo {
  return {
    sha: record.sha,
    subject: record.subject,
    authorName: record.authorName,
    authorEmail: record.authorEmail,
    authorDate: record.authorDate,
    committerName: record.committerName,
    committerEmail: record.committerEmail,
    commitDate: record.commitDate,
  };
}

/**
 * Parses `git log -z --format=%m%x1f<COMMIT_FORMAT>` output: each commit with its mark
 * (`<`/`>` for the side of a symmetric range, `=` when `--cherry-mark` found an equivalent).
 */
export function parseMarkedCommitRecords(
  output: string,
): Array<{ mark: string; commit: CommitRecord }> {
  return output
    .split('\0')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r !== '')
    .flatMap((record) => {
      const separator = record.indexOf('\x1f');
      if (separator < 0) return [];
      const [commit] = parseCommitRecords(record.slice(separator + 1));
      return commit ? [{ mark: record.slice(0, separator), commit }] : [];
    });
}
