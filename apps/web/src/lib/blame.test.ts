import type { CommitInfo, GitAncestry, GitBlame } from '@om/shared';
import { describe, expect, it } from 'vitest';
import { blameMarks, sharedWith } from './blame.ts';

const info = (sha: string, subject: string): CommitInfo => ({
  sha,
  subject,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-02T00:00:00Z',
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate: '2026-01-02T00:00:00Z',
});

const blame: GitBlame = {
  path: 'a.txt',
  commit: 'L',
  lines: [
    { line: 1, commit: 'c1', origLine: 1, boundary: false },
    { line: 2, commit: 'c2', origLine: 2, boundary: true },
    { line: 3, commit: 'c1', origLine: 3, boundary: false },
  ],
  commits: [info('c1', 'first change'), info('c2', 'second change')],
};

describe('blameMarks', () => {
  it('gives every blamed line its commit, and says which commits the other side has too', () => {
    const marks = blameMarks(blame, new Set(['c2']));
    expect(marks.size).toBe(3);
    expect(marks.get(1)).toEqual({
      sha: 'c1',
      subject: 'first change',
      authorName: 'Ada',
      authorDate: '2026-01-02T00:00:00Z',
      isShared: false,
    });
    expect(marks.get(2)?.isShared).toBe(true);
  });

  it('keeps a line whose commit is not in the list, without a subject', () => {
    const marks = blameMarks({ ...blame, commits: [] }, new Set());
    expect(marks.get(1)).toMatchObject({ sha: 'c1', subject: '', authorName: '' });
  });
});

describe('sharedWith', () => {
  it('lists the commits the other side has in its history', () => {
    const ancestry: GitAncestry = {
      results: [
        { commit: 'c1', isAncestor: false },
        { commit: 'c2', isAncestor: true },
        { commit: 'c3', isAncestor: null },
      ],
    };
    expect([...sharedWith(ancestry)]).toEqual(['c2']);
  });

  it('is empty until the answer arrives', () => {
    expect(sharedWith(undefined).size).toBe(0);
  });
});
