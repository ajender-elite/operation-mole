import type { GitService } from '../git/git-service.ts';

/** Commits per call, so the diffs read stay within the output limit. */
export const MAX_PATCH_ID_COMMITS = 200;

/**
 * The patch id of each commit (`git patch-id --stable`): equal ids mean the same change, whatever the
 * commit or branch. Null for a merge (no diff to compare) and for an empty commit. Commits must exist
 * in the repo (see `objectTypes`).
 */
export async function patchIdsOf(
  git: GitService,
  repoDir: string,
  commits: readonly string[],
  opt: { signal?: AbortSignal },
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>(commits.map((commit) => [commit, null]));
  if (commits.length === 0) return result;
  // The diffs of the commits, as `git log -p` writes them (each with its `commit <sha>` header).
  const { stdout: diffs } = await git.run(
    repoDir,
    [
      'log',
      '-p',
      '--no-merges',
      '--no-walk=unsorted',
      '--no-ext-diff',
      '--no-textconv',
      ...commits,
      '--',
    ],
    opt,
  );
  if (diffs === '') return result;
  const { stdout } = await git.run(repoDir, ['patch-id', '--stable'], {
    ...opt,
    input: diffs,
  });
  for (const line of stdout.split('\n')) {
    const [patchId = '', commit = ''] = line.trim().split(/\s+/);
    if (patchId !== '' && result.has(commit)) result.set(commit, patchId);
  }
  return result;
}
