import type { CommitInfo, DiffLine, DivergenceCommit, SnapshotFileDiff } from '@om/shared';
import { gitAncestry, gitBlame, gitDiff } from './api.ts';
import type { DiffTarget } from './attribution.ts';
import type { SnapshotPair } from './snapshot-diff.ts';

/**
 * One file's diff between two pinned commits, as the File Compare shows it. The hunks come from git's
 * diff. Attribution, when asked for, is composed here from git primitives: each changed line's commit
 * is the one that last changed it on its own side (`blame`, Left's lines for removed lines and Right's
 * for added ones), and each such commit is marked as in each side's history (`ancestry`). The backend
 * answers the git questions; what they mean for this screen is decided here.
 */
export async function loadFileDiff(
  pair: SnapshotPair,
  target: DiffTarget,
  isFullFile: boolean,
  isAttributed: boolean,
  signal?: AbortSignal,
): Promise<SnapshotFileDiff> {
  const { user, sessionId, left, right } = pair;
  const file = {
    ...(target.leftPath === undefined ? {} : { leftPath: target.leftPath }),
    ...(target.rightPath === undefined ? {} : { rightPath: target.rightPath }),
  };
  const { files } = await gitDiff(
    { user, sessionId, left, right, files: [file], fullFile: isFullFile },
    signal,
  );
  const diff = files[0];
  if (diff === undefined) throw new Error('The diff of this file came back empty');
  if (!isAttributed || diff.content !== 'text') return diff;

  const removed = changedNumbers(diff.hunks, 'removed');
  const added = changedNumbers(diff.hunks, 'added');
  const [blameLeft, blameRight] = await Promise.all([
    target.leftPath !== undefined && removed.length > 0
      ? gitBlame({ user, sessionId, source: left, path: target.leftPath, lines: removed }, signal)
      : undefined,
    target.rightPath !== undefined && added.length > 0
      ? gitBlame({ user, sessionId, source: right, path: target.rightPath, lines: added }, signal)
      : undefined,
  ]);

  // Every commit that accounts for a changed line, with its metadata from the blame answers.
  const info = new Map<string, CommitInfo>();
  for (const blame of [blameLeft, blameRight]) {
    for (const commit of blame?.commits ?? []) info.set(commit.sha, commit);
  }
  const shas = [...info.keys()];
  const [leftHistory, rightHistory] = await Promise.all([
    shas.length > 0
      ? gitAncestry({ user, sessionId, tip: left, commits: shas }, signal)
      : undefined,
    shas.length > 0
      ? gitAncestry({ user, sessionId, tip: right, commits: shas }, signal)
      : undefined,
  ]);
  const inLeft = new Map((leftHistory?.results ?? []).map((r) => [r.commit, r.isAncestor]));
  const inRight = new Map((rightHistory?.results ?? []).map((r) => [r.commit, r.isAncestor]));
  const commits: DivergenceCommit[] = [...info.values()].map((commit) => ({
    ...commit,
    inLeft: inLeft.get(commit.sha) ?? null,
    inRight: inRight.get(commit.sha) ?? null,
  }));

  const leftCommitByLine = new Map((blameLeft?.lines ?? []).map((l) => [l.line, l.commit]));
  const rightCommitByLine = new Map((blameRight?.lines ?? []).map((l) => [l.line, l.commit]));
  const hunks = diff.hunks.map((hunk) => ({
    ...hunk,
    lines: hunk.lines.map((line): DiffLine => {
      const sha = committedLine(line, leftCommitByLine, rightCommitByLine);
      return sha === undefined ? line : { ...line, commit: sha };
    }),
  }));
  return { ...diff, hunks, commits };
}

/** The line numbers on one side that a diff changes (removed lines in Left, added lines in Right). */
function changedNumbers(hunks: SnapshotFileDiff['hunks'], kind: 'removed' | 'added'): number[] {
  const numbers: number[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== kind) continue;
      const number = kind === 'removed' ? line.leftLine : line.rightLine;
      if (number !== undefined) numbers.push(number);
    }
  }
  return [...new Set(numbers)];
}

/** The commit that last changed a changed line on its own side, if it was asked for and found. */
function committedLine(
  line: DiffLine,
  leftCommitByLine: ReadonlyMap<number, string>,
  rightCommitByLine: ReadonlyMap<number, string>,
): string | undefined {
  if (line.kind === 'removed' && line.leftLine !== undefined)
    return leftCommitByLine.get(line.leftLine);
  if (line.kind === 'added' && line.rightLine !== undefined)
    return rightCommitByLine.get(line.rightLine);
  return undefined;
}
