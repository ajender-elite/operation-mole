import type { GitBlame } from '@om/shared';
import { describe, expect, it } from 'vitest';
import { codeRows, formatLineRange, parseLineRange } from './code-lines.ts';
import { commitInfo } from '../test/explore-handlers.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('parseLineRange', () => {
  it('reads a range, or one line, and refuses anything else', () => {
    expect(parseLineRange('10-20')).toEqual({ start: 10, end: 20 });
    expect(parseLineRange('12')).toEqual({ start: 12, end: 12 });
    expect(parseLineRange(null)).toBeUndefined();
    expect(parseLineRange('20-10')).toBeUndefined();
    expect(parseLineRange('0')).toBeUndefined();
    expect(parseLineRange('a-b')).toBeUndefined();
  });

  it('writes a range the way the URL reads it back', () => {
    expect(formatLineRange({ start: 10, end: 20 })).toBe('10-20');
    expect(formatLineRange({ start: 3, end: 3 })).toBe('3');
    expect(parseLineRange(formatLineRange({ start: 3, end: 9 }))).toEqual({ start: 3, end: 9 });
  });
});

describe('codeRows', () => {
  const blame: GitBlame = {
    path: 'a.c',
    commit: B,
    lines: [
      { line: 1, commit: A, origLine: 1, boundary: true },
      { line: 2, commit: A, origLine: 2, boundary: true },
      { line: 3, commit: B, origLine: 3, boundary: false },
    ],
    commits: [commitInfo(A, 'Add a'), commitInfo(B, 'Change c')],
  };

  it('numbers the lines and gives each its commit', () => {
    const rows = codeRows('one\ntwo\nthree\n', blame);
    expect(rows.map((r) => [r.number, r.text, r.commit?.sha])).toEqual([
      [1, 'one', A],
      [2, 'two', A],
      [3, 'three', B],
    ]);
  });

  it('starts a run where the commit changes, so the tag shows once per run', () => {
    const rows = codeRows('one\ntwo\nthree\n', blame);
    expect(rows.map((r) => r.isRunStart)).toEqual([true, false, true]);
  });

  it('leaves a line blame does not cover without a commit', () => {
    const rows = codeRows('one\ntwo\nthree\nfour\n', blame);
    expect(rows[3]?.commit).toBeUndefined();
    expect(rows[3]?.isRunStart).toBe(false);
  });

  it('has no rows for an empty file and no commits without blame', () => {
    expect(codeRows('', undefined)).toEqual([]);
    expect(codeRows('x\n', undefined)).toEqual([
      { number: 1, text: 'x', commit: undefined, isRunStart: false },
    ]);
  });
});
