import { describe, expect, it } from 'vitest';
import { isoWithOffset, parseBlamePorcelain } from '../src/snapshot/blame-parse.ts';
import { parseCommitRecords, parseMarkedCommitRecords } from '../src/snapshot/commit-records.ts';
import {
  lineRanges,
  parseHunks,
  splitFilePatches,
  wholeFileHunk,
} from '../src/snapshot/diff-parse.ts';
import { LruCache } from '../src/snapshot/lru-cache.ts';
import { conflictExcerpts } from '../src/upstream/upstream-analyzer.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('parseHunks', () => {
  const patch = [
    'diff --git a/f b/f',
    'index 1..2 100644',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,3 @@ fn()',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '@@ -10 +10,2 @@',
    ' ten',
    '+eleven',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('numbers lines on each side and keeps the header', () => {
    const { hunks, isTruncated } = parseHunks(patch);
    expect(isTruncated).toBe(false);
    expect(
      hunks.map((h) => [h.header, h.leftStart, h.leftCount, h.rightStart, h.rightCount]),
    ).toEqual([
      ['@@ -1,3 +1,3 @@ fn()', 1, 3, 1, 3],
      ['@@ -10 +10,2 @@', 10, 1, 10, 2],
    ]);
    expect(hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'one', leftLine: 1, rightLine: 1 },
      { kind: 'removed', text: 'two', leftLine: 2 },
      { kind: 'added', text: 'TWO', rightLine: 2 },
      { kind: 'context', text: 'three', leftLine: 3, rightLine: 3 },
    ]);
    expect(hunks[1]?.lines.at(-1)).toEqual({ kind: 'added', text: 'eleven', rightLine: 11 });
  });

  it('stops at the line limit and says so', () => {
    const { hunks, isTruncated } = parseHunks(patch, 3);
    expect(isTruncated).toBe(true);
    expect(hunks.flatMap((h) => h.lines)).toHaveLength(3);
  });
});

describe('wholeFileHunk', () => {
  it('turns a one-sided file into one hunk', () => {
    expect(wholeFileHunk('a\nb\n', 'right', 10).hunks[0]).toMatchObject({
      header: '@@ -0,0 +1,2 @@',
      lines: [
        { kind: 'added', text: 'a', rightLine: 1 },
        { kind: 'added', text: 'b', rightLine: 2 },
      ],
    });
    expect(wholeFileHunk('', 'left', 10).hunks).toEqual([]);
    expect(wholeFileHunk('a\nb\nc', 'left', 2)).toMatchObject({ isTruncated: true });
  });
});

describe('splitFilePatches and lineRanges', () => {
  it('splits a multi-file patch in order', () => {
    const chunks = splitFilePatches(
      'diff --git a/x b/x\n+1\ndiff --git a/y b/y\nBinary files a/y and b/y differ\n',
    );
    expect(chunks).toEqual([
      'diff --git a/x b/x\n+1\n',
      'diff --git a/y b/y\nBinary files a/y and b/y differ\n',
    ]);
    expect(splitFilePatches('')).toEqual([]);
  });

  it('collapses lines into ranges', () => {
    expect(lineRanges([5, 1, 2, 3, 9])).toEqual([
      [1, 3],
      [5, 5],
      [9, 9],
    ]);
    expect(lineRanges([1, 5, 9], 3)).toEqual([[1, 9]]);
  });
});

describe('parseBlamePorcelain', () => {
  it('maps final lines to commits and reads metadata once per commit', () => {
    const out = [
      `${A} 1 1 2`,
      'author Ann',
      'author-mail <ann@example.com>',
      'author-time 1700000000',
      'author-tz -0800',
      'committer Cy',
      'committer-mail <cy@example.com>',
      'committer-time 1700003600',
      'committer-tz +0530',
      'summary First thing',
      'filename f',
      '\tline one',
      `${A} 2 2`,
      '\tline two',
      `${B} 7 3 1`,
      'author Bo',
      'author-mail <bo@example.com>',
      'author-time 0',
      'author-tz +0000',
      'committer Bo',
      'committer-mail <bo@example.com>',
      'committer-time 0',
      'committer-tz +0000',
      'summary Second',
      'boundary',
      'filename f',
      '\tline three',
    ].join('\n');
    const { lines, commits } = parseBlamePorcelain(out);
    expect([...lines]).toEqual([
      [1, A],
      [2, A],
      [3, B],
    ]);
    expect(commits.get(A)).toEqual({
      sha: A,
      subject: 'First thing',
      authorName: 'Ann',
      authorEmail: 'ann@example.com',
      authorDate: '2023-11-14T14:13:20-08:00',
      committerName: 'Cy',
      committerEmail: 'cy@example.com',
      commitDate: '2023-11-15T04:43:20+05:30',
    });
    expect(commits.get(B)?.authorDate).toBe('1970-01-01T00:00:00Z');
  });

  it('formats dates like git %aI', () => {
    expect(isoWithOffset(1315975361, '-0700')).toBe('2011-09-13T21:42:41-07:00');
  });
});

describe('commit records', () => {
  it('parses log -z records, with and without marks', () => {
    const rec = [
      A,
      `${B} ${A}`,
      'Ann',
      'ann@x',
      '2026-01-01T00:00:00Z',
      'Cy',
      'cy@x',
      '2026-01-02T00:00:00Z',
      'Sub\x1fject',
    ].join('\x1f');
    expect(parseCommitRecords(`${rec}\0`)).toEqual([
      {
        sha: A,
        parents: [B, A],
        subject: 'Sub\x1fject',
        authorName: 'Ann',
        authorEmail: 'ann@x',
        authorDate: '2026-01-01T00:00:00Z',
        committerName: 'Cy',
        committerEmail: 'cy@x',
        commitDate: '2026-01-02T00:00:00Z',
      },
    ]);
    expect(parseMarkedCommitRecords(`=\x1f${rec}\0\n<\x1f${rec}\0`).map((r) => r.mark)).toEqual([
      '=',
      '<',
    ]);
  });
});

describe('conflictExcerpts', () => {
  it('cuts each conflict with context, merging nearby ones', () => {
    const text = [
      'a',
      'b',
      '<<<<<<< ours',
      'x',
      '=======',
      'y',
      '>>>>>>> theirs',
      'c',
      '<<<<<<< o',
      '1',
      '=======',
      '2',
      '>>>>>>> t',
      'd',
      'e',
      'f',
      'g',
      'h',
    ].join('\n');
    const excerpts = conflictExcerpts('f.txt', text, { context: 1 });
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toMatchObject({ path: 'f.txt', startLine: 2 });
    expect(excerpts[0]?.lines.at(-1)).toBe('d');
  });

  it('respects the line budget', () => {
    const text = Array.from(
      { length: 50 },
      (_, i) => `<<<<<<<\n${i}\n=======\n>>>>>>>\nsep\nsep\nsep\nsep\nsep\nsep\nsep`,
    ).join('\n');
    const lines = conflictExcerpts('f', text, { maxLines: 20 }).flatMap((e) => e.lines);
    expect(lines.length).toBeLessThanOrEqual(20);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });
});
