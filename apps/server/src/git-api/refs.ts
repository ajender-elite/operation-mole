import type { GitRefEntry, GitRefKind } from '@om/shared';
import { compareNames } from '../compare/sort.ts';
import type { GitService } from '../git/git-service.ts';

/** Field separator inside one `for-each-ref` line (a control character no ref or subject contains). */
const FIELD = '\x1f';

/**
 * Whether this git can count ahead/behind in one `for-each-ref` (`%(ahead-behind:<commit>)`, git 2.41+).
 * `version` is git's own text, e.g. `2.47.0.windows.2`.
 */
export function hasAheadBehind(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 41);
}

/** Splits `refs/remotes/<remote>/<name>` (or `refs/remote-tags/…`) into its remote, kind and name. */
function parseRefName(refName: string): { remote: string; kind: GitRefKind; name: string } | null {
  const match = /^refs\/(remotes|remote-tags)\/([^/]+)\/(.+)$/.exec(refName);
  if (match === null) return null;
  const [, space = '', remote = '', name = ''] = match;
  if (name === 'HEAD') return null; // the remote's own default-branch pointer, not a branch of its own
  return { remote, kind: space === 'remote-tags' ? 'tag' : 'branch', name };
}

/** Every branch and tag of every remote of a repo (`refs/remotes`, `refs/remote-tags`), in order. */
export async function listRefs(
  git: GitService,
  repoDir: string,
  opt: { signal?: AbortSignal; compareTo?: string | undefined; withAheadBehind: boolean },
): Promise<GitRefEntry[]> {
  const isCounted = opt.compareTo !== undefined && opt.withAheadBehind;
  const format = [
    '%(refname)',
    '%(objectname)',
    '%(committerdate:iso-strict)',
    '%(subject)',
    ...(isCounted ? [`%(ahead-behind:${opt.compareTo ?? ''})`] : []),
  ].join(FIELD);
  const { stdout } = await git.run(
    repoDir,
    ['for-each-ref', `--format=${format}`, 'refs/remotes', 'refs/remote-tags'],
    opt.signal === undefined ? {} : { signal: opt.signal },
  );
  const refs: GitRefEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [refName = '', commit = '', commitDate = '', subject = '', counts = ''] =
      line.split(FIELD);
    const parsed = parseRefName(refName);
    if (parsed === null) continue;
    const pair = /^(\d+) (\d+)$/.exec(counts);
    refs.push({
      ...parsed,
      commit,
      commitDate,
      subject,
      ...(isCounted && pair !== null ? { ahead: Number(pair[1]), behind: Number(pair[2]) } : {}),
    });
  }
  return refs.sort(
    (a, b) =>
      compareNames(a.remote, b.remote) ||
      (a.kind === b.kind ? 0 : a.kind === 'branch' ? -1 : 1) ||
      compareNames(a.name, b.name),
  );
}

/** Every branch and tag (of any remote) whose history includes `commit` (`for-each-ref --contains`). */
export async function containingRefs(
  git: GitService,
  repoDir: string,
  commit: string,
  opt: { signal?: AbortSignal },
): Promise<Array<{ remote: string; kind: GitRefKind; name: string }>> {
  const { stdout } = await git.run(
    repoDir,
    [
      'for-each-ref',
      '--format=%(refname)',
      `--contains=${commit}`,
      'refs/remotes',
      'refs/remote-tags',
    ],
    opt,
  );
  return stdout
    .split('\n')
    .flatMap((refName) => {
      const parsed = parseRefName(refName.trim());
      return parsed === null ? [] : [parsed];
    })
    .sort(
      (a, b) =>
        compareNames(a.remote, b.remote) ||
        (a.kind === b.kind ? 0 : a.kind === 'branch' ? -1 : 1) ||
        compareNames(a.name, b.name),
    );
}
