import { describe, expect, it } from 'vitest';
import { compareTreeLeaves } from '../src/compare/git-trees.ts';
import type { TreeLeaf } from '../src/git-api/trees.ts';

/*
 * The comparison rules of Folder Compare, on the trees of two git sides (leaves by path, as
 * `listLeaves` gives them). No checkout and no disk: a file is the same when its object id is.
 */

const file = (oid: string, size = 1): TreeLeaf => ({ kind: 'file', oid, size });

const compare = (left: Record<string, TreeLeaf>, right: Record<string, TreeLeaf>) =>
  compareTreeLeaves({
    left: new Map(Object.entries(left)),
    right: new Map(Object.entries(right)),
    linkTargets: new Map(),
    leftLabel: 'L',
    rightLabel: 'R',
  });

/** The children of a folder as [name, status] pairs, in the order the tree gives them. */
const listing = (children: Array<{ name: string; status: string }> | undefined) =>
  (children ?? []).map((c) => [c.name, c.status]);

describe('Folder Compare rules on git trees', () => {
  it('marks fully identical trees as identical', () => {
    const r = compare({ 'a.txt': file('1') }, { 'a.txt': file('1') });
    expect(r.root.status).toBe('identical');
    expect(listing(r.root.children)).toEqual([['a.txt', 'identical']]);
  });

  it('detects files specific to each side', () => {
    const r = compare({ 'left.txt': file('1') }, { 'right.txt': file('2') });
    expect(listing(r.root.children)).toEqual([
      ['left.txt', 'only-left'],
      ['right.txt', 'only-right'],
    ]);
  });

  it('marks same-path files with different content as modified', () => {
    const r = compare({ 'a.txt': file('1') }, { 'a.txt': file('2') });
    expect(listing(r.root.children)).toEqual([['a.txt', 'modified']]);
    expect(r.root.status).toBe('modified');
  });

  it('compares content by object id: the same id is the same content', () => {
    const r = compare({ 'a.txt': file('same', 3) }, { 'a.txt': file('same', 3) });
    expect(listing(r.root.children)).toEqual([['a.txt', 'identical']]);
  });

  it('includes the whole content of a folder present on one side only', () => {
    const r = compare({ 'dir/a.txt': file('1'), 'dir/sub/b.txt': file('2') }, {});
    const dir = r.root.children?.[0];
    expect(dir?.status).toBe('only-left');
    expect(listing(dir?.children)).toEqual([
      ['sub', 'only-left'],
      ['a.txt', 'only-left'],
    ]);
  });

  it('propagates a difference to its ancestor folders only', () => {
    const r = compare(
      { 'a/b/x.txt': file('1'), 'a/b/y.txt': file('2'), 'c/z.txt': file('3') },
      { 'a/b/x.txt': file('1'), 'a/b/y.txt': file('9'), 'c/z.txt': file('3') },
    );
    expect(listing(r.root.children)).toEqual([
      ['a', 'modified'],
      ['c', 'identical'],
    ]);
    expect(listing(r.root.children?.[0]?.children)).toEqual([['b', 'modified']]);
  });

  it('lists a file and a folder with the same name as two one-sided entries', () => {
    const r = compare({ clash: file('1') }, { 'clash/x.txt': file('2') });
    expect(listing(r.root.children)).toEqual([
      ['clash', 'only-right'],
      ['clash', 'only-left'],
    ]);
  });

  it('lists all folders first, then all files, each in natural ascending order', () => {
    const r = compare(
      {
        'file10.txt': file('1'),
        'file2.txt': file('2'),
        'zeta/x': file('3'),
        'Alpha/x': file('4'),
      },
      {
        'file10.txt': file('1'),
        'file2.txt': file('2'),
        'zeta/x': file('3'),
        'Alpha/x': file('4'),
      },
    );
    expect(listing(r.root.children).map(([name]) => name)).toEqual([
      'Alpha',
      'zeta',
      'file2.txt',
      'file10.txt',
    ]);
  });

  it('matches names with accents and spaces across sides', () => {
    const r = compare({ 'café menu.txt': file('1') }, { 'café menu.txt': file('1') });
    expect(listing(r.root.children)).toEqual([['café menu.txt', 'identical']]);
  });

  it('uses POSIX paths', () => {
    const r = compare({ 'a/b/c.txt': file('1') }, { 'a/b/c.txt': file('2') });
    const c = r.root.children?.[0]?.children?.[0]?.children?.[0];
    expect(c?.path).toBe('a/b/c.txt');
  });

  it('labels each side with the given labels', () => {
    const r = compare({}, {});
    expect([r.leftLabel, r.rightLabel]).toEqual(['L', 'R']);
  });
});
