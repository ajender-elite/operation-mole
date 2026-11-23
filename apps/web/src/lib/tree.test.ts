import type { CompareNode } from '@om/shared';
import { describe, expect, it } from 'vitest';
import { root } from '../test/fixtures.ts';
import {
  breadcrumbs,
  collectDirectoryPaths,
  countUnder,
  findNode,
  flattenTree,
  joinPath,
  rowKey,
} from './tree.ts';

describe('findNode', () => {
  it('returns the root for an empty path', () => {
    expect(findNode(root, '')).toBe(root);
  });
  it('finds nested nodes', () => {
    expect(findNode(root, 'docs/old/a.txt')?.status).toBe('only-left');
  });
  it('prefers the folder when a file and a folder share a name', () => {
    expect(findNode(root, 'output')?.right?.kind).toBe('directory');
    expect(findNode(root, 'output/report.txt')?.status).toBe('only-right');
  });
  it('returns undefined for unknown paths', () => {
    expect(findNode(root, 'docs/nope')).toBeUndefined();
    expect(findNode(root, 'same.txt/child')).toBeUndefined();
  });
});

describe('flattenTree', () => {
  it('lists only direct children when nothing is expanded', () => {
    const rows = flattenTree(root, new Set(), 'all');
    expect(rows.map((r) => r.node.name)).toEqual([
      'docs',
      'src',
      'output',
      'new.txt',
      'output',
      'same.txt',
    ]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(rows[0]).toMatchObject({ isDirectory: true, expanded: false });
    expect(rows[3]).toMatchObject({ isDirectory: false, expanded: false });
  });

  it('includes children of expanded directories with increasing depth', () => {
    const rows = flattenTree(root, new Set(['docs', 'docs/old']), 'all');
    expect(rows.map((r) => [r.node.path, r.depth])).toEqual([
      ['docs', 0],
      ['docs/old', 1],
      ['docs/old/a.txt', 2],
      ['docs/guide.md', 1],
      ['docs/readme.md', 1],
      ['src', 0],
      ['output', 0],
      ['new.txt', 0],
      ['output', 0],
      ['same.txt', 0],
    ]);
    expect(rows[0]?.expanded).toBe(true);
  });

  it('starts from a subdirectory', () => {
    const docs = findNode(root, 'docs');
    if (!docs) throw new Error('fixture');
    expect(flattenTree(docs, new Set(), 'all').map((r) => r.node.name)).toEqual([
      'old',
      'guide.md',
      'readme.md',
    ]);
  });

  it('hides identical entries when filtering to differences', () => {
    const rows = flattenTree(root, new Set(['docs', 'src']), 'differences');
    expect(rows.map((r) => r.node.path)).toEqual([
      'docs',
      'docs/old',
      'docs/readme.md',
      'output',
      'new.txt',
      'output',
    ]);
  });
});

describe('breadcrumbs', () => {
  it('returns just the root for an empty path', () => {
    expect(breadcrumbs('')).toEqual([{ name: '', path: '' }]);
  });
  it('returns one crumb per segment', () => {
    expect(breadcrumbs('a/b/c')).toEqual([
      { name: '', path: '' },
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
      { name: 'c', path: 'a/b/c' },
    ]);
  });
});

describe('collectDirectoryPaths', () => {
  it('returns every descendant directory path', () => {
    expect(collectDirectoryPaths(root).sort()).toEqual(['docs', 'docs/old', 'output', 'src']);
  });
});

describe('joinPath', () => {
  it('joins a root and a relative path', () => {
    expect(joinPath('/a/b', 'c/d.txt')).toBe('/a/b/c/d.txt');
    expect(joinPath('/a/b/', 'c')).toBe('/a/b/c');
    expect(joinPath('/a', '')).toBe('/a');
    expect(joinPath('/', 'x')).toBe('/x');
  });

  it('joins Windows roots with backslashes', () => {
    expect(joinPath('C:\\a\\b', 'c/d.txt')).toBe('C:\\a\\b\\c\\d.txt');
    expect(joinPath('C:\\a\\b\\', 'c')).toBe('C:\\a\\b\\c');
    expect(joinPath('C:\\', 'x')).toBe('C:\\x');
    expect(joinPath('C:\\a', '')).toBe('C:\\a');
  });

  it('keeps forward slashes for Windows roots written with them', () => {
    expect(joinPath('C:/a/b/', 'c/d.txt')).toBe('C:/a/b/c/d.txt');
  });
});

describe('rowKey', () => {
  it('is unique even when a file and a folder share a path', () => {
    const keys = flattenTree(root, new Set(), 'all').map((r) => rowKey(r.node));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('countUnder', () => {
  it('counts the files under a folder by status, not the folders themselves', () => {
    const counts = countUnder(root);
    expect(counts).toEqual({
      identical: countStatus('identical'),
      modified: countStatus('modified'),
      onlyLeft: countStatus('only-left'),
      onlyRight: countStatus('only-right'),
      errors: countStatus('error'),
    });
    expect(counts.onlyLeft).toBeGreaterThan(0);
  });
  it('only counts what lies under the given folder', () => {
    const docs = findNode(root, 'docs');
    if (!docs) throw new Error('fixture has no docs folder');
    const all = countUnder(root);
    const inDocs = countUnder(docs);
    expect(inDocs.onlyLeft).toBeLessThanOrEqual(all.onlyLeft);
    expect(inDocs.onlyLeft).toBeGreaterThan(0);
  });
});

/** Files of one status in the whole fixture, walked independently of countUnder. */
function countStatus(status: string): number {
  const walk = (n: CompareNode): number =>
    n.children ? n.children.reduce((sum, c) => sum + walk(c), 0) : n.status === status ? 1 : 0;
  return walk(root);
}
