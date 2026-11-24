import type { CommitPatch, PatchFile } from '@om/shared';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import { COMMIT_FORMAT, parseCommitRecords } from '../snapshot/commit-records.ts';
import { parseHunks, splitFilePatches } from '../snapshot/diff-parse.ts';

/** The tree with no entries, per object format: the "parent" of a root commit. */
const EMPTY_TREE: Record<number, string> = {
  40: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  64: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

type ChangedFile = { status: string; path: string; oldPath?: string };

/** `git diff --name-status -z` records: `M\0path\0`, `R092\0old\0new\0`. */
function parseNameStatus(output: string): ChangedFile[] {
  const tokens = output.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i] ?? '';
    if (status === '') {
      i++;
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
      i += 3;
    } else {
      files.push({ status, path: tokens[i + 1] ?? '' });
      i += 2;
    }
  }
  return files;
}

/** Size limits for a commit's patch. */
export type PatchLimits = { maxPatchFiles: number; maxPatchLines: number };

/**
 * A commit's patch against its first parent, file by file, with hunks (`git show`'s diff, as data).
 * Read only: no ref, index or worktree is touched.
 */
export class CommitPatchReader {
  readonly #git: GitService;
  readonly #limits: PatchLimits;

  constructor(git: GitService, limits: Partial<PatchLimits> = {}) {
    this.#git = git;
    this.#limits = { maxPatchFiles: 300, maxPatchLines: 20_000, ...limits };
  }

  /** A commit's parents, and the tree its patch is taken against: its first parent, or the empty tree. */
  async #parents(
    repoDir: string,
    commit: string,
    opt: { signal?: AbortSignal },
  ): Promise<{ parents: string[]; base: string }> {
    const { stdout } = await this.#git.run(
      repoDir,
      ['rev-list', '--parents', '-n', '1', commit, '--'],
      opt,
    );
    const [, ...parents] = stdout.trim().split(' ');
    const base = parents[0] ?? EMPTY_TREE[commit.length] ?? '';
    return { parents, base };
  }

  /** A commit's patch against its first parent (the empty tree for a root commit). */
  async patch(
    upstream: ResolvedSnapshot,
    commit: string,
    signal?: AbortSignal,
  ): Promise<CommitPatch> {
    const opt = signal ? { signal } : {};
    const { parents, base } = await this.#parents(upstream.repoDir, commit, opt);
    const diffTree = (...flags: string[]) =>
      this.#git.run(
        upstream.repoDir,
        ['diff-tree', '-r', '-M', '--no-commit-id', ...flags, base, commit, '--'],
        opt,
      );
    // Same diff, same order: the name-status list says unambiguously which file each patch is.
    const [nameStatusOut, patchOut] = await Promise.all([
      diffTree('-z', '--name-status'),
      diffTree('-p', '--no-color', '--no-ext-diff', '--no-textconv'),
    ]);
    const changed = parseNameStatus(nameStatusOut.stdout);
    const chunks = splitFilePatches(patchOut.stdout);
    let budget = this.#limits.maxPatchLines;
    let isTruncated = changed.length > this.#limits.maxPatchFiles;
    const files = changed.slice(0, this.#limits.maxPatchFiles).map((file, i): PatchFile => {
      const chunk = chunks[i] ?? '';
      const parsed = parseHunks(chunk, Math.max(budget, 0));
      budget -= parsed.hunks.reduce((n, h) => n + h.lines.length, 0);
      if (parsed.isTruncated) isTruncated = true;
      const status = file.status[0];
      return {
        ...(status === 'A' ? {} : { oldPath: file.oldPath ?? file.path }),
        ...(status === 'D' ? {} : { newPath: file.path }),
        status:
          status === 'A'
            ? 'added'
            : status === 'D'
              ? 'deleted'
              : status === 'M'
                ? 'modified'
                : status === 'R'
                  ? 'renamed'
                  : 'other',
        binary: /^Binary files .* differ$/m.test(chunk),
        hunks: parsed.hunks,
      };
    });
    const logged = await this.#git.run(
      upstream.repoDir,
      ['log', '-1', '-z', `--format=${COMMIT_FORMAT}`, commit, '--'],
      opt,
    );
    const [details] = parseCommitRecords(logged.stdout);
    if (details === undefined) throw new Error(`Commit ${commit} not found`);
    return {
      commit,
      details,
      ...(parents[0] === undefined ? {} : { baseParent: parents[0] }),
      files,
      truncated: isTruncated,
    };
  }
}
