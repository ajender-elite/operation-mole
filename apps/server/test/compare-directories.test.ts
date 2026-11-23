import { chmod } from 'node:fs/promises';
import path from 'node:path';
import type { CompareNode } from '@om/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompareInputError, compareDirectories } from '../src/compare/compare-directories.ts';
import { canCreateSymlinks, canMakeFilesUnreadable } from './capabilities.ts';
import { createWorkspace } from './fixtures.ts';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
beforeAll(async () => {
  ws = await createWorkspace();
});
afterAll(() => ws.cleanup());

/** Find a node by relative path. */
function find(root: CompareNode, rel: string): CompareNode {
  if (rel === '') return root;
  let node = root;
  for (const part of rel.split('/')) {
    const next = node.children?.find((c) => c.name === part);
    if (!next) throw new Error(`No node at ${rel}`);
    node = next;
  }
  return node;
}

describe('compareDirectories', () => {
  it('marks fully identical trees as identical', async () => {
    const spec = { 'a.txt': 'A', sub: { 'b.txt': 'B', deeper: { 'c.txt': 'C' } } };
    const { left, right } = await ws.pair(spec, spec);
    const result = await compareDirectories(left, right);

    expect(result.left).toBe(left);
    expect(result.right).toBe(right);
    expect(result.root.status).toBe('identical');
    expect(find(result.root, 'sub/deeper/c.txt').status).toBe('identical');
    expect(result.summary).toEqual({
      identical: 3,
      modified: 0,
      onlyLeft: 0,
      onlyRight: 0,
      errors: 0,
    });
  });

  it('detects files specific to each side', async () => {
    const { left, right } = await ws.pair(
      { 'common.txt': 'x', 'left.txt': 'L' },
      { 'common.txt': 'x', 'right.txt': 'R' },
    );
    const { root, summary } = await compareDirectories(left, right);

    const l = find(root, 'left.txt');
    expect(l.status).toBe('only-left');
    expect(l.left?.kind).toBe('file');
    expect(l.right).toBeUndefined();

    const r = find(root, 'right.txt');
    expect(r.status).toBe('only-right');
    expect(r.right?.kind).toBe('file');
    expect(r.left).toBeUndefined();

    expect(root.status).toBe('modified');
    expect(summary).toEqual({ identical: 1, modified: 0, onlyLeft: 1, onlyRight: 1, errors: 0 });
  });

  it('marks same-path files with different bytes as modified', async () => {
    const { left, right } = await ws.pair(
      { 'same-size.txt': 'abc', 'diff-size.txt': 'abc' },
      { 'same-size.txt': 'abd', 'diff-size.txt': 'abcd' },
    );
    const { root, summary } = await compareDirectories(left, right);
    expect(find(root, 'same-size.txt').status).toBe('modified');
    expect(find(root, 'diff-size.txt').status).toBe('modified');
    expect(find(root, 'diff-size.txt').left?.size).toBe(3);
    expect(find(root, 'diff-size.txt').right?.size).toBe(4);
    expect(summary.modified).toBe(2);
  });

  it('compares exact bytes: line endings, trailing spaces, empty and binary files', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
    const { left, right } = await ws.pair(
      {
        'crlf.txt': 'one\ntwo\n',
        'trailing.txt': 'text\n',
        'empty.txt': '',
        'same.bin': png,
        'changed.bin': png,
      },
      {
        'crlf.txt': 'one\r\ntwo\r\n',
        'trailing.txt': 'text \n',
        'empty.txt': '',
        'same.bin': png,
        'changed.bin': Buffer.concat([png, Buffer.from([2])]),
      },
    );
    const { root } = await compareDirectories(left, right);
    const status = (name: string) => find(root, name).status;
    expect(['crlf.txt', 'trailing.txt', 'changed.bin'].map(status)).toEqual([
      'modified',
      'modified',
      'modified',
    ]);
    expect(['empty.txt', 'same.bin'].map(status)).toEqual(['identical', 'identical']);
    expect(find(root, 'empty.txt').left?.size).toBe(0);
  });

  it('matches names with accents and spaces across sides', async () => {
    const { left, right } = await ws.pair(
      { 'résumé.txt': 'cv', 'my notes.txt': 'a', 'naïve dir': { 'x.txt': 'x' } },
      { 'résumé.txt': 'cv', 'my notes.txt': 'b', 'naïve dir': { 'x.txt': 'x' } },
    );
    const { root, summary } = await compareDirectories(left, right);
    // HFS+ (older macOS) hands names back decomposed; compare them normalized.
    const byName = (name: string) =>
      root.children?.find((c) => c.name.normalize('NFC') === name.normalize('NFC'));
    expect(byName('résumé.txt')?.status).toBe('identical');
    expect(byName('my notes.txt')?.status).toBe('modified');
    expect(byName('naïve dir')?.status).toBe('identical');
    expect(summary).toEqual({ identical: 2, modified: 1, onlyLeft: 0, onlyRight: 0, errors: 0 });
  });

  it('includes the full contents of a directory present on one side only', async () => {
    const { left, right } = await ws.pair({ only: { 'a.txt': 'a', nested: { 'b.txt': 'b' } } }, {});
    const { root, summary } = await compareDirectories(left, right);
    const only = find(root, 'only');
    expect(only.status).toBe('only-left');
    expect(only.left?.kind).toBe('directory');
    expect(find(root, 'only/nested/b.txt').status).toBe('only-left');
    expect(find(root, 'only/nested').status).toBe('only-left');
    expect(summary.onlyLeft).toBe(2);
  });

  it('propagates differences to ancestor directories only', async () => {
    const { left, right } = await ws.pair(
      { a: { b: { 'x.txt': '1' }, same: { 'y.txt': 'y' } } },
      { a: { b: { 'x.txt': '2' }, same: { 'y.txt': 'y' } } },
    );
    const { root } = await compareDirectories(left, right);
    expect(root.status).toBe('modified');
    expect(find(root, 'a').status).toBe('modified');
    expect(find(root, 'a/b').status).toBe('modified');
    expect(find(root, 'a/same').status).toBe('identical');
  });

  it('handles empty directories', async () => {
    const { left, right } = await ws.pair({ empty: {}, leftEmpty: {} }, { empty: {} });
    const { root } = await compareDirectories(left, right);
    expect(find(root, 'empty').status).toBe('identical');
    expect(find(root, 'empty').children).toEqual([]);
    expect(find(root, 'leftEmpty').status).toBe('only-left');
  });

  it('lists a file and a folder with the same name as two one-sided entries', async () => {
    const { left, right } = await ws.pair(
      { thing: 'file', other: { 'x.txt': 'x' } },
      { thing: { 'inner.txt': 'i' }, other: 'now a file' },
    );
    const { root, summary } = await compareDirectories(left, right);
    const named = (name: string) => root.children?.filter((c) => c.name === name) ?? [];

    const [thingDir, thingFile] = [
      named('thing').find((n) => n.children !== undefined),
      named('thing').find((n) => n.children === undefined),
    ];
    expect(named('thing')).toHaveLength(2);
    expect(thingFile).toMatchObject({ status: 'only-left', left: { kind: 'file' } });
    expect(thingFile?.right).toBeUndefined();
    expect(thingDir).toMatchObject({ status: 'only-right', right: { kind: 'directory' } });
    expect(thingDir?.left).toBeUndefined();
    expect(thingDir?.children?.[0]).toMatchObject({
      path: 'thing/inner.txt',
      status: 'only-right',
    });

    const otherDir = named('other').find((n) => n.children !== undefined);
    const otherFile = named('other').find((n) => n.children === undefined);
    expect(otherDir).toMatchObject({ status: 'only-left', left: { kind: 'directory' } });
    expect(otherFile).toMatchObject({ status: 'only-right', right: { kind: 'file' } });

    // Folders sort before files, so each pair is split across the two groups.
    expect(root.children?.map((c) => c.name)).toEqual(['other', 'thing', 'other', 'thing']);
    expect(root.status).toBe('modified');
    expect(summary).toEqual({ identical: 0, modified: 0, onlyLeft: 2, onlyRight: 2, errors: 0 });
  });

  // Windows needs Developer Mode (or admin) to create symlinks.
  it.runIf(canCreateSymlinks)('compares symlinks by target without following them', async () => {
    const { left, right } = await ws.pair(
      { dir: { 'f.txt': 'f' }, same: { symlink: 'dir' }, other: { symlink: 'dir' } },
      {
        dir: { 'f.txt': 'f' },
        same: { symlink: 'dir' },
        other: { symlink: 'elsewhere' },
        added: { symlink: 'dir' },
      },
    );
    const { root } = await compareDirectories(left, right);
    const same = find(root, 'same');
    expect(same.status).toBe('identical');
    expect(same.left?.kind).toBe('symlink');
    expect(same.left?.linkTarget).toBe('dir');
    expect(same.children).toBeUndefined();
    expect(find(root, 'other').status).toBe('modified');
    expect(find(root, 'added')).toMatchObject({ status: 'only-right', right: { kind: 'symlink' } });
  });

  it.runIf(canCreateSymlinks)('marks a symlink that became a file as modified', async () => {
    const { left, right } = await ws.pair(
      { 'target.txt': 't', entry: { symlink: 'target.txt' } },
      { 'target.txt': 't', entry: 't' },
    );
    const { root } = await compareDirectories(left, right);
    const entry = find(root, 'entry');
    expect(entry.status).toBe('modified');
    expect(entry.left?.kind).toBe('symlink');
    expect(entry.right?.kind).toBe('file');
  });

  it('sorts children with directories first, then by name', async () => {
    const spec = { 'b.txt': '', 'A.txt': '', zdir: {}, adir: {}, 'c.txt': '' };
    const { left, right } = await ws.pair(spec, spec);
    const { root } = await compareDirectories(left, right);
    expect(root.children?.map((c) => c.name)).toEqual(['adir', 'zdir', 'A.txt', 'b.txt', 'c.txt']);
  });

  it('lists all folders first, then all files, each in natural ascending order', async () => {
    const spec = {
      'file10.txt': '',
      'README.md': '',
      'file2.txt': '',
      'b.txt': '',
      dir10: {},
      Zeta: {},
      dir2: {},
      alpha: {},
      // A symlink to a folder still sorts with the files (when the OS lets us create one).
      ...(canCreateSymlinks ? { link: { symlink: 'alpha' } } : {}),
    };
    const { left, right } = await ws.pair(spec, { ...spec, beta: {}, 'c.txt': '' });
    const { root } = await compareDirectories(left, right);
    expect(root.children?.map((c) => c.name)).toEqual([
      'alpha',
      'beta',
      'dir2',
      'dir10',
      'Zeta',
      'b.txt',
      'c.txt',
      'file2.txt',
      'file10.txt',
      ...(canCreateSymlinks ? ['link'] : []),
      'README.md',
    ]);
  });

  it('uses POSIX relative paths and an empty root path', async () => {
    const { left, right } = await ws.pair({ a: { b: { 'c.txt': '' } } }, {});
    const { root } = await compareDirectories(left, right);
    expect(root.path).toBe('');
    expect(root.name).toBe('');
    expect(find(root, 'a/b/c.txt').path).toBe('a/b/c.txt');
  });

  // chmod can't make a file unreadable on Windows, nor for root.
  it.runIf(canMakeFilesUnreadable)('reports unreadable files as errors', async () => {
    const { left, right } = await ws.pair({ 'locked.txt': 'a' }, { 'locked.txt': 'a' });
    await chmod(path.join(left, 'locked.txt'), 0o000);
    try {
      const { root, summary } = await compareDirectories(left, right);
      const locked = find(root, 'locked.txt');
      expect(locked.status).toBe('error');
      expect(locked.error).toBeTruthy();
      expect(root.status).toBe('modified');
      expect(summary.errors).toBe(1);
    } finally {
      await chmod(path.join(left, 'locked.txt'), 0o644);
    }
  });

  it('labels each side with its path by default, or with given labels', async () => {
    const { left, right } = await ws.pair({}, {});
    expect(await compareDirectories(left, right)).toMatchObject({
      leftLabel: left,
      rightLabel: right,
    });
    expect(
      await compareDirectories(left, right, { leftLabel: 'app @ main', rightLabel: 'app @ dev' }),
    ).toMatchObject({ leftLabel: 'app @ main', rightLabel: 'app @ dev' });
  });

  it('ignores given names at the root of each side only', async () => {
    const { left, right } = await ws.pair(
      { '.git': 'gitdir: /somewhere', 'a.txt': 'a', sub: { '.git': 'nested' } },
      { 'a.txt': 'a', sub: { '.git': 'nested' } },
    );
    const { root, summary } = await compareDirectories(left, right, {
      ignoreAtRoot: { left: ['.git'], right: ['.git'] },
    });
    expect(root.children?.map((c) => c.name)).toEqual(['sub', 'a.txt']);
    expect(find(root, 'sub/.git').status).toBe('identical');
    expect(root.status).toBe('identical');
    expect(summary.onlyLeft).toBe(0);
  });

  it('rejects a missing root', async () => {
    const { left } = await ws.pair({}, {});
    await expect(compareDirectories(left, path.join(ws.base, 'nope'))).rejects.toBeInstanceOf(
      CompareInputError,
    );
  });

  it('rejects a root that is not a directory', async () => {
    const { left } = await ws.pair({ 'f.txt': 'x' }, {});
    await expect(compareDirectories(path.join(left, 'f.txt'), left)).rejects.toThrow(
      /not a directory/i,
    );
  });
});
