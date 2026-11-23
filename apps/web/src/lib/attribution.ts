import type {
  CompareNode,
  DiffHunk,
  DiffLine,
  DivergenceCommit,
  SnapshotFileDiff,
  SnapshotSide,
} from '@om/shared';

/** A file to diff between two snapshots: one tree entry, or both ends of a rename. */
export type DiffTarget = {
  /** Identifies the difference: the Base path, or the Target path for a Target-only file. */
  key: string;
  leftPath?: string;
  rightPath?: string;
};

const target = (leftPath: string | undefined, rightPath: string | undefined): DiffTarget => ({
  key: leftPath ?? rightPath ?? '',
  ...(leftPath === undefined ? {} : { leftPath }),
  ...(rightPath === undefined ? {} : { rightPath }),
});

/**
 * What to diff for a tree entry: the same path on both sides, one side only, or, for a
 * detected rename, the old path in Base against the new path in Target. Undefined for folders.
 */
export function diffTarget(node: CompareNode): DiffTarget | undefined {
  if (node.children !== undefined) return undefined;
  if (node.left && node.right) return target(node.path, node.path);
  if (node.left) return target(node.path, node.renamedTo);
  return target(node.renamedFrom, node.path);
}

/** Every differing file under `dir`; a rename pair counts once. */
export function differingFiles(dir: CompareNode): DiffTarget[] {
  const found: DiffTarget[] = [];
  const walk = (node: CompareNode) => {
    for (const child of node.children ?? []) {
      if (child.children !== undefined) walk(child);
      else if (child.status === 'identical' || child.status === 'error') continue;
      else if (child.status === 'only-right' && child.renamedFrom !== undefined) continue;
      else {
        const t = diffTarget(child);
        if (t) found.push(t);
      }
    }
  };
  walk(dir);
  return found;
}

/** The snapshot a changed line belongs to: removed lines are Base content, added lines Target content. */
export function lineSide(line: DiffLine): SnapshotSide | undefined {
  if (line.kind === 'removed') return 'left';
  if (line.kind === 'added') return 'right';
  return undefined;
}

/** How much of a scope's difference one commit currently accounts for. */
export type CommitShare = {
  commit: DivergenceCommit;
  /** Base-only lines attributed to it (from Base history). */
  leftLines: number;
  /** Target-only lines attributed to it (from Target history). */
  rightLines: number;
  hunks: number;
  /** Keys of the files it appears in. */
  files: string[];
};

/** Diffs to summarize; `hunks` narrows an entry to some of its hunks (hunk scope). */
export type AttributionInput = Array<{ key: string; diff: SnapshotFileDiff; hunks?: DiffHunk[] }>;

/** Attribution for a scope: commits ranked by lines, and how many changed lines had none. */
export type ScopeAttribution = {
  shares: CommitShare[];
  changedLines: number;
  unattributedLines: number;
};

/**
 * Which commits currently account for the changed lines in a scope (a hunk, a file, or a
 * folder's files), counted per side. Commits in only one snapshot's history come first: they
 * are what diverged. Commits in both histories (shared content the other side changed) come
 * after. Within each group: most lines first, then newest commit first.
 */
export function summarizeAttribution(entries: AttributionInput): ScopeAttribution {
  const shares = new Map<string, CommitShare>();
  let changedLines = 0;
  let unattributedLines = 0;
  for (const { key, diff, hunks = diff.hunks } of entries) {
    const commits = new Map(diff.commits.map((c) => [c.sha, c]));
    for (const hunk of hunks) {
      const inHunk = new Set<string>();
      for (const line of hunk.lines) {
        const side = lineSide(line);
        if (!side) continue;
        changedLines++;
        const commit = line.commit === undefined ? undefined : commits.get(line.commit);
        if (!commit) {
          unattributedLines++;
          continue;
        }
        const share = shares.get(commit.sha) ?? {
          commit,
          leftLines: 0,
          rightLines: 0,
          hunks: 0,
          files: [],
        };
        if (side === 'left') share.leftLines++;
        else share.rightLines++;
        if (!inHunk.has(commit.sha)) {
          inHunk.add(commit.sha);
          share.hunks++;
        }
        if (!share.files.includes(key)) share.files.push(key);
        shares.set(commit.sha, share);
      }
    }
  }
  return {
    shares: [...shares.values()].sort(
      (a, b) =>
        Number(commitPlacement(a.commit) === 'both') -
          Number(commitPlacement(b.commit) === 'both') ||
        b.leftLines + b.rightLines - (a.leftLines + a.rightLines) ||
        b.commit.commitDate.localeCompare(a.commit.commitDate),
    ),
    changedLines,
    unattributedLines,
  };
}

/** Where one commit accounts for differences: per file, its lines and hunk indexes. */
export type CommitFootprint = Array<{ key: string; lines: number; hunks: number[] }>;

/** The differences (files, hunks, line counts) a commit accounts for, among the given diffs. */
export function commitFootprint(sha: string, entries: AttributionInput): CommitFootprint {
  return entries.flatMap(({ key, diff }) => {
    let lines = 0;
    const hunks: number[] = [];
    for (const [index, hunk] of diff.hunks.entries()) {
      const count = hunk.lines.filter((l) => l.commit === sha && l.kind !== 'context').length;
      if (count > 0) hunks.push(index);
      lines += count;
    }
    return lines > 0 ? [{ key, lines, hunks }] : [];
  });
}

/** First 8 characters of a commit SHA. */
export const shortSha = (sha: string): string => sha.slice(0, 8);

/**
 * How a commit relates to the two snapshots, for the "is this really divergence?" question:
 * a commit reachable from both sides is shared history; the difference on that line comes
 * from the other side changing it.
 */
export function commitPlacement(c: DivergenceCommit): 'left' | 'right' | 'both' | 'unknown' {
  if (c.inLeft === true && c.inRight === true) return 'both';
  if (c.inLeft === true && c.inRight === false) return 'left';
  if (c.inRight === true && c.inLeft === false) return 'right';
  return 'unknown';
}
