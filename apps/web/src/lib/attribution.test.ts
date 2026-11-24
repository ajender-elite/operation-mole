import type { CompareNode, DivergenceCommit, SnapshotFileDiff } from '@om/shared';
import { describe, expect, it } from 'vitest';
import {
  commitFootprint,
  commitPlacement,
  diffTarget,
  differingFiles,
  summarizeAttribution,
} from './attribution.ts';

const commit = (sha: string, over: Partial<DivergenceCommit> = {}): DivergenceCommit => ({
  sha,
  subject: sha,
  authorName: 'A',
  authorEmail: 'a@x',
  authorDate: '2026-01-01T00:00:00Z',
  committerName: 'A',
  committerEmail: 'a@x',
  commitDate: '2026-01-01T00:00:00Z',
  inLeft: false,
  inRight: true,
  ...over,
});

const file = (kind: 'file' = 'file') => ({ kind, size: 1, mtimeMs: 0 });

describe('diffTarget / differingFiles', () => {
  const dir: CompareNode = {
    name: 'd',
    path: 'd',
    status: 'modified',
    children: [
      { name: 'm', path: 'd/m', status: 'modified', left: file(), right: file() },
      { name: 'same', path: 'd/same', status: 'identical', left: file(), right: file() },
      {
        name: 'old',
        path: 'd/old',
        status: 'only-left',
        left: file(),
        renamedTo: 'd/new',
        similarity: 90,
      },
      {
        name: 'new',
        path: 'd/new',
        status: 'only-right',
        right: file(),
        renamedFrom: 'd/old',
        similarity: 90,
      },
      { name: 'gone', path: 'd/gone', status: 'only-left', left: file() },
      {
        name: 'sub',
        path: 'd/sub',
        status: 'modified',
        children: [{ name: 'added', path: 'd/sub/added', status: 'only-right', right: file() }],
      },
    ],
  };

  it('pairs renames and lists every difference once', () => {
    expect(differingFiles(dir)).toEqual([
      { key: 'd/m', leftPath: 'd/m', rightPath: 'd/m' },
      { key: 'd/old', leftPath: 'd/old', rightPath: 'd/new' },
      { key: 'd/gone', leftPath: 'd/gone' },
      { key: 'd/sub/added', rightPath: 'd/sub/added' },
    ]);
  });

  it('diffs the Right end of a rename against its Left path', () => {
    expect(diffTarget(dir.children![3]!)).toEqual({
      key: 'd/old',
      leftPath: 'd/old',
      rightPath: 'd/new',
    });
    expect(diffTarget(dir)).toBeUndefined();
  });
});

const diff = (
  lines: Array<[kind: 'context' | 'removed' | 'added', commit?: string]>,
  commits: DivergenceCommit[],
): SnapshotFileDiff => ({
  leftCommit: 'L',
  rightCommit: 'R',
  content: 'text',
  commits,
  hunks: [
    {
      header: '@@',
      leftStart: 1,
      leftCount: 1,
      rightStart: 1,
      rightCount: 1,
      lines: lines.map(([kind, sha]) => ({
        kind,
        text: 'x',
        ...(sha === undefined ? {} : { commit: sha }),
      })),
    },
  ],
});

describe('summarizeAttribution', () => {
  const a = commit('a', { inLeft: true, inRight: true, commitDate: '2026-01-01T00:00:00Z' });
  const b = commit('b', { commitDate: '2026-01-02T00:00:00Z' });
  const c = commit('c', { commitDate: '2026-01-03T00:00:00Z' });

  it('counts lines per side, hunks and files for each commit', () => {
    const one = diff(
      [['context'], ['removed', 'a'], ['added', 'c'], ['added', 'b'], ['added', 'b']],
      [a, b, c],
    );
    const two = diff([['added', 'b'], ['added']], [b]);
    const result = summarizeAttribution([
      { key: 'f1', diff: one },
      { key: 'f2', diff: two },
    ]);
    expect(result.changedLines).toBe(6);
    expect(result.unattributedLines).toBe(1);
    expect(
      result.shares.map((s) => [s.commit.sha, s.leftLines, s.rightLines, s.hunks, s.files]),
    ).toEqual([
      ['b', 0, 3, 2, ['f1', 'f2']],
      ['c', 0, 1, 1, ['f1']],
      ['a', 1, 0, 1, ['f1']],
    ]);
  });

  it('ranks commits in only one history before shared history', () => {
    const shared = commit('s', { inLeft: true, inRight: true });
    const d = diff(
      [
        ['added', 's'],
        ['added', 's'],
        ['added', 's'],
        ['added', 'b'],
      ],
      [shared, b],
    );
    expect(summarizeAttribution([{ key: 'f', diff: d }]).shares.map((s) => s.commit.sha)).toEqual([
      'b',
      's',
    ]);
  });

  it('narrows to the given hunks', () => {
    const d = diff([['added', 'b']], [b]);
    expect(summarizeAttribution([{ key: 'f', diff: d, hunks: [] }]).shares).toEqual([]);
  });

  it('finds where a commit accounts for differences', () => {
    const one = diff(
      [
        ['added', 'b'],
        ['added', 'c'],
      ],
      [b, c],
    );
    const two = diff([['added', 'c']], [c]);
    expect(
      commitFootprint('b', [
        { key: 'f1', diff: one },
        { key: 'f2', diff: two },
      ]),
    ).toEqual([{ key: 'f1', lines: 1, hunks: [0] }]);
  });

  it('places commits relative to the two snapshots', () => {
    expect(commitPlacement(a)).toBe('both');
    expect(commitPlacement(b)).toBe('right');
    expect(commitPlacement(commit('x', { inLeft: true, inRight: false }))).toBe('left');
    expect(commitPlacement(commit('y', { inLeft: null }))).toBe('unknown');
  });
});
