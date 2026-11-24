import type { GitService } from '../git/git-service.ts';
import type { ObjectView } from '../snapshot/object-view.ts';

/** The largest conflicted file whose merged text is returned. */
export const MAX_CONFLICT_BYTES = 8 * 1024 * 1024;
/** Same heuristic as git: a NUL byte in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * The merged text (with conflict markers) of one file of a merge result tree, read from the scratch
 * object store. `null` when the file is binary, `undefined` when it is absent (a modify/delete
 * conflict has no file in the result; git's messages say so).
 */
export async function readMergedFile(
  git: GitService,
  view: ObjectView,
  tree: string,
  path: string,
  opt: { signal?: AbortSignal },
): Promise<string | null | undefined> {
  try {
    const { stdout } = await git.runBuffer(view.cwd, ['cat-file', 'blob', `${tree}:${path}`], {
      env: view.env,
      maxBytes: MAX_CONFLICT_BYTES,
      ...opt,
    });
    return stdout.subarray(0, BINARY_SNIFF_BYTES).includes(0) ? null : stdout.toString('utf8');
  } catch (err) {
    if (opt.signal?.aborted === true) throw err;
    return undefined;
  }
}
