import type {
  GitCherryPick,
  CherryPickIssue,
  CherryPickIssueProblem,
  CherryPickStep,
  CherryPickWarning,
} from '@om/shared';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import { toCommitInfo } from '../snapshot/commit-records.ts';
import { objectView, withScratchObjects } from '../snapshot/object-view.ts';
import type { SnapshotAnalyzer } from '../snapshot/snapshot-analyzer.ts';
import { readCommits, objectTypes, type CommitWithFiles } from './commit-check.ts';
import { readMergedFile } from './merged-file.ts';
import { parseMergeTree } from './merge-tree-parse.ts';

/** Conflicted files whose merged text a step returns. */
const MAX_CONFLICT_FILES = 10;

/** Who the commits made in the scratch store are written by. They never reach a ref. */
const SCRATCH_IDENTITY = {
  GIT_AUTHOR_NAME: 'OM',
  GIT_AUTHOR_EMAIL: 'om@localhost',
  GIT_COMMITTER_NAME: 'OM',
  GIT_COMMITTER_EMAIL: 'om@localhost',
};

export type CherryPickDeps = {
  git: GitService;
  snapshots: SnapshotAnalyzer;
  scratchDir: string;
};

const ISSUE_TEXT: Record<CherryPickIssueProblem, string> = {
  'not-found': 'Not a commit in this repository',
  'not-a-commit': 'Not a commit (it names a tree, a blob or a tag)',
  duplicate: 'Listed more than once',
  merge: 'A merge commit: cherry-picking it needs a mainline parent, which OM does not choose yet',
  root: 'A root commit has no parent to pick it against',
};

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * Would `git cherry-pick <commits…>` onto `onto` succeed, applied in the order given, each on the result
 * of the one before? It is a dry run: the picks are merged in a scratch object store that is removed
 * afterwards, so no ref, index or worktree is touched.
 *
 * 1. The request is checked first. Any problem (a missing commit, a duplicate, a merge, a root commit)
 *    refuses the whole series and no step runs.
 * 2. Each commit is then merged onto the result so far, with its own parent as the base (`git cherry-pick`
 *    does the same). A commit already in `onto`'s history is skipped. A commit whose change is already
 *    present leaves the result unchanged, and the run goes on. The first conflict stops the run.
 */
export async function cherryPickSeries(
  deps: CherryPickDeps,
  onto: ResolvedSnapshot,
  commits: readonly string[],
  signal?: AbortSignal,
): Promise<GitCherryPick> {
  const { git, snapshots, scratchDir } = deps;
  const opt = signal ? { signal } : {};
  const ontoRevision = { commit: onto.commit, ref: onto.ref, label: onto.label };

  // 1. The pre-check.
  const types = await objectTypes(git, onto.repoDir, commits, opt);
  const issues: CherryPickIssue[] = [];
  const seen = new Set<string>();
  const validIds: string[] = [];
  for (const [index, commit] of commits.entries()) {
    const type = types[index];
    const refuse = (problem: CherryPickIssueProblem) => {
      issues.push({ index, commit, problem, message: ISSUE_TEXT[problem] });
    };
    if (type === 'missing' || type === undefined) refuse('not-found');
    else if (type !== 'commit') refuse('not-a-commit');
    else if (seen.has(commit)) refuse('duplicate');
    else {
      seen.add(commit);
      validIds.push(commit);
    }
  }
  const details = new Map<string, CommitWithFiles>();
  for (const record of await readCommits(git, onto.repoDir, validIds, opt)) {
    details.set(record.sha, record);
  }
  for (const [index, commit] of commits.entries()) {
    const record = details.get(commit);
    if (record === undefined) continue;
    if (record.parents.length > 1) {
      issues.push({ index, commit, problem: 'merge', message: ISSUE_TEXT.merge });
    } else if (record.parents.length === 0) {
      issues.push({ index, commit, problem: 'root', message: ISSUE_TEXT.root });
    }
  }
  const warnings: CherryPickWarning[] = [];
  for (const [index, commit] of commits.entries()) {
    const parent = details.get(commit)?.parents[0];
    const parentAt = parent === undefined ? -1 : commits.indexOf(parent);
    if (parentAt > index) {
      warnings.push({
        index,
        kind: 'parent-after-child',
        message: `${shortSha(commit)} is listed before its parent ${shortSha(parent ?? '')}`,
      });
    }
  }
  if (issues.length > 0) {
    return {
      onto: ontoRevision,
      outcome: 'invalid',
      issues: issues.sort((a, b) => a.index - b.index),
      warnings,
      steps: [],
      changedPaths: [],
    };
  }

  // Blobs that the merges read, fetched in one request (a blob-less clone would fetch them one by one).
  const touched = [...new Set(validIds.flatMap((id) => details.get(id)?.files ?? []))];
  const parents = validIds.flatMap((id) => details.get(id)?.parents ?? []);
  await git.prefetchMissing(onto.repoDir, [onto.commit, ...validIds, ...parents], touched, {
    isWalking: false,
    remote: onto.remote,
    ...opt,
  });

  // 2. The chain of dry-run picks, in one scratch object store.
  const view = objectView(onto.repoDir);
  return await withScratchObjects(view, scratchDir, async (scratch) => {
    const env = scratch.env;
    const ontoTree = (
      await git.run(scratch.cwd, ['rev-parse', `${onto.commit}^{tree}`], { env, ...opt })
    ).stdout.trim();
    let current = onto.commit;
    let currentTree = ontoTree;
    let stoppedAt: number | undefined;
    const steps: CherryPickStep[] = [];

    for (const [index, commit] of commits.entries()) {
      const record = details.get(commit);
      if (record === undefined) continue; // refused by the pre-check
      const step = (fields: Partial<CherryPickStep>): CherryPickStep => ({
        index,
        commit: { ...toCommitInfo(record), parents: record.parents },
        status: 'applies',
        files: record.files,
        conflictedPaths: [],
        conflictedFiles: [],
        messages: [],
        ...fields,
      });
      if (stoppedAt !== undefined) {
        steps.push(step({ status: 'not-run' }));
        continue;
      }
      const isInHistory = await snapshots.isAncestor(
        onto.cacheScope,
        view,
        commit,
        onto.commit,
        signal,
      );
      if (isInHistory === true) {
        steps.push(step({ status: 'in-history' }));
        continue;
      }

      const merge = await git.run(
        scratch.cwd,
        [
          'merge-tree',
          '--write-tree',
          '-z',
          '--name-only',
          `--merge-base=${record.parents[0] ?? ''}`,
          current,
          commit,
        ],
        { env, okExitCodes: [0, 1], ...opt },
      );
      const parsed = parseMergeTree(merge.stdout);
      if (merge.exitCode !== 0) {
        const conflictedFiles: Array<{ path: string; text: string | null }> = [];
        for (const path of parsed.conflicted.slice(0, MAX_CONFLICT_FILES)) {
          const text = await readMergedFile(git, scratch, parsed.tree, path, opt);
          if (text !== undefined) conflictedFiles.push({ path, text });
        }
        stoppedAt = index;
        steps.push(
          step({
            status: 'conflict',
            conflictedPaths: parsed.conflicted,
            conflictedFiles,
            messages: parsed.messages,
          }),
        );
        continue;
      }
      if (parsed.tree === currentTree) {
        steps.push(step({ status: 'no-change', messages: parsed.messages }));
        continue;
      }
      // The result becomes the next pick's ours: a commit in the scratch store, since a merge
      // takes commits (its parent is not needed: each merge names its base).
      current = (
        await git.run(scratch.cwd, ['commit-tree', parsed.tree, '-m', `cherry-pick ${commit}`], {
          env: { ...env, ...SCRATCH_IDENTITY },
          ...opt,
        })
      ).stdout.trim();
      currentTree = parsed.tree;
      steps.push(step({ status: 'applies', messages: parsed.messages }));
    }

    const changed =
      currentTree === ontoTree
        ? []
        : (
            await git.run(
              scratch.cwd,
              ['diff-tree', '-r', '-z', '--name-only', '--no-renames', onto.commit, currentTree],
              { env, ...opt },
            )
          ).stdout
            .split('\0')
            .filter((p) => p !== '');

    return {
      onto: ontoRevision,
      outcome: stoppedAt === undefined ? 'applies' : 'conflict',
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
      issues: [],
      warnings,
      steps,
      changedPaths: changed,
    };
  });
}
