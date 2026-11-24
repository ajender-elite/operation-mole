import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';

/** A file of a tree as git lists it: its kind, its object id (the blob, or the submodule commit), its size. */
export type TreeLeaf = {
  kind: 'file' | 'symlink' | 'submodule';
  oid: string;
  size: number;
};

/**
 * The files (leaves) of one commit's tree, by path, from `git ls-tree -r -l`. With `paths`, only
 * those paths are read (literally, see `--literal-pathspecs`). Folders are not returned.
 */
export async function listLeaves(
  git: GitService,
  snapshot: ResolvedSnapshot,
  paths: readonly string[] | undefined,
  opt: { signal?: AbortSignal },
): Promise<Map<string, TreeLeaf>> {
  const { stdout } = await git.run(
    snapshot.repoDir,
    ['ls-tree', '-r', '-l', '-z', snapshot.commit, '--', ...(paths ?? [])],
    opt,
  );
  const leaves = new Map<string, TreeLeaf>();
  for (const record of stdout.split('\0')) {
    const match = /^(\d+) (\S+) (\S+) +(\S+)\t([\s\S]*)$/.exec(record);
    if (!match) continue;
    const [, mode = '', type = '', oid = '', size = '-', path = ''] = match;
    const kind = type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
    leaves.set(path, { kind, oid, size: size === '-' ? 0 : Number(size) });
  }
  return leaves;
}

/**
 * The target of each symlink in `leaves`: a symlink's blob holds its target path. Read once per
 * object id (a blob-less clone fetches each one it lacks).
 */
export async function readLinkTargets(
  git: GitService,
  snapshot: ResolvedSnapshot,
  leaves: ReadonlyMap<string, TreeLeaf>,
  opt: { signal?: AbortSignal },
): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  const oids = [
    ...new Set([...leaves.values()].filter((l) => l.kind === 'symlink').map((l) => l.oid)),
  ];
  for (const oid of oids) {
    const { stdout } = await git.run(snapshot.repoDir, ['cat-file', 'blob', oid], opt);
    targets.set(oid, stdout);
  }
  return targets;
}

/**
 * Downloads every file of a commit's tree that a blob-less clone lacks, in one request (as a checkout
 * did). Listing sizes (`ls-tree -l`) or reading contents otherwise fetches each file on its own, and
 * parallel readers then write and read the same packs.
 */
export async function prefetchTree(
  git: GitService,
  snapshot: ResolvedSnapshot,
  opt: { signal?: AbortSignal },
): Promise<void> {
  const { stdout } = await git.run(
    snapshot.repoDir,
    ['ls-tree', '-z', '--name-only', snapshot.commit],
    opt,
  );
  const topLevel = stdout.split('\0').filter((name) => name !== '');
  await git.prefetchMissing(snapshot.repoDir, [snapshot.commit], topLevel, {
    isWalking: false,
    remote: snapshot.remote,
    ...(opt.signal === undefined ? {} : { signal: opt.signal }),
  });
}
