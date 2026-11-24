import type { DiffHunk } from '@om/shared';
import { describe, expect, it } from 'vitest';
import { diffText, tokensByLine } from './diff-highlight.ts';

const hunk = (texts: string[]): DiffHunk => ({
  header: '@@ -1 +1 @@',
  leftStart: 1,
  leftCount: texts.length,
  rightStart: 1,
  rightCount: texts.length,
  lines: texts.map((text, i) => ({
    kind: 'context' as const,
    text,
    leftLine: i + 1,
    rightLine: i + 1,
  })),
});

describe('diffText', () => {
  it('joins the lines of every hunk, in order, one per line', () => {
    expect(diffText([hunk(['a', 'b']), hunk(['c'])])).toBe('a\nb\nc');
  });
});

describe('tokensByLine', () => {
  it('gives each hunk the tokens of its own lines, in the order the text had them', () => {
    const lines = [[{ content: 'a' }], [{ content: 'b' }], [{ content: 'c' }]];
    const byLine = tokensByLine([hunk(['a', 'b']), hunk(['c'])], lines);
    expect(byLine?.map((h) => h.map((t) => t[0]?.content))).toEqual([['a', 'b'], ['c']]);
  });

  it('is undefined when there is no highlighting, and empty tokens for a line that has none', () => {
    expect(tokensByLine([hunk(['a'])], undefined)).toBeUndefined();
    expect(tokensByLine([hunk(['a', 'b'])], [[{ content: 'a' }]])?.[0]?.[1]).toEqual([]);
  });
});
