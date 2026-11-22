import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where and how to run git so one process sees the objects of several clones: the first
 * clone is the repository, the others are added as alternates through the environment
 * (nothing is written to any clone's config). Used to diff or merge commits that live in
 * different remotes' clones.
 */
export type ObjectView = {
  cwd: string;
  env: Record<string, string>;
};

const objectsDir = (repoDir: string) => path.join(repoDir, 'objects');

/** A read-only view of `repoDir`'s objects plus those of `others` (duplicates ignored). */
export function objectView(repoDir: string, ...others: string[]): ObjectView {
  const extra = [...new Set(others)].filter((d) => d !== repoDir).map(objectsDir);
  return {
    cwd: repoDir,
    env: extra.length > 0 ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: extra.join(path.delimiter) } : {},
  };
}

/**
 * Runs `task` with a view whose NEW objects (e.g. the trees `git merge-tree --write-tree`
 * creates) go to a fresh scratch directory under `scratchRoot`, removed afterwards whatever
 * happens (success, conflict, failure or abort). The clones' object databases are only read.
 */
export async function withScratchObjects<T>(
  view: ObjectView,
  scratchRoot: string,
  task: (scratchView: ObjectView) => Promise<T>,
): Promise<T> {
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(path.join(scratchRoot, 'objects-'));
  try {
    const alternates = [objectsDir(view.cwd)];
    const existing = view.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
    if (existing !== undefined) alternates.push(existing);
    return await task({
      cwd: view.cwd,
      env: {
        ...view.env,
        GIT_OBJECT_DIRECTORY: dir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(path.delimiter),
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
