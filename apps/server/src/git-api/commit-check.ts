import type { GitService } from '../git/git-service.ts';
import {
  COMMIT_FORMAT,
  parseCommitRecords,
  type CommitRecord,
} from '../snapshot/commit-records.ts';

/** A commit with the paths it changes (`git log --name-only`; none for a merge). */
export type CommitWithFiles = CommitRecord & { files: string[] };

/**
 * The type of each object id, in the order given (`cat-file --batch-check`): `commit`, `tree`, `blob`,
 * `tag`, or `missing`. Ids must be full SHAs (which can't be ambiguous).
 */
export async function objectTypes(
  git: GitService,
  repoDir: string,
  ids: readonly string[],
  opt: { signal?: AbortSignal },
): Promise<string[]> {
  if (ids.length === 0) return [];
  const { stdout } = await git.run(repoDir, ['cat-file', '--batch-check=%(objecttype)'], {
    ...opt,
    input: `${ids.join('\n')}\n`,
  });
  // A missing id is echoed back before its type ("<id> missing"), so the type is the last word.
  return stdout
    .split('\n')
    .slice(0, ids.length)
    .map((line) => line.split(' ').pop() ?? '');
}

/**
 * Commit metadata, parents and changed paths for commits that exist (`git log --no-walk`), in the
 * order given. Each id must already be a commit (see {@link objectTypes}).
 */
export async function readCommits(
  git: GitService,
  repoDir: string,
  ids: readonly string[],
  opt: { signal?: AbortSignal },
): Promise<CommitWithFiles[]> {
  if (ids.length === 0) return [];
  const { stdout } = await git.run(
    repoDir,
    [
      'log',
      '--no-walk=unsorted',
      '-z',
      '--name-only',
      `--format=\x1e${COMMIT_FORMAT}`,
      ...ids,
      '--',
    ],
    opt,
  );
  const byId = new Map<string, CommitWithFiles>();
  let current: CommitWithFiles | undefined;
  for (const raw of stdout.split('\0')) {
    const token = raw.replace(/^\n/, '');
    if (token === '') continue;
    if (token.startsWith('\x1e')) {
      const [record] = parseCommitRecords(token.slice(1));
      current = record === undefined ? undefined : { ...record, files: [] };
      if (current !== undefined) byId.set(current.sha, current);
    } else {
      current?.files.push(token);
    }
  }
  return ids.flatMap((id) => {
    const found = byId.get(id);
    return found === undefined ? [] : [found];
  });
}
