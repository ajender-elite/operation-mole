import type { CompareNode, EntryInfo } from '@om/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { flattenTree } from '../lib/tree.ts';
import { stubViewport } from '../test/setup.ts';
import { CompareTree } from './compare-tree.tsx';

const FILE: EntryInfo = { kind: 'file', size: 10, mtimeMs: 0 };
const DIR: EntryInfo = { kind: 'directory', size: 0, mtimeMs: 0 };

const file = (name: string, path: string): CompareNode => ({
  name,
  path,
  status: 'modified',
  left: FILE,
  right: FILE,
});

const folder = (name: string, path: string, children: CompareNode[]): CompareNode => ({
  name,
  path,
  status: 'modified',
  left: DIR,
  right: DIR,
  children,
});

const root: CompareNode = {
  name: '',
  path: '',
  status: 'modified',
  left: DIR,
  right: DIR,
  children: [folder('src', 'src', [file('a.txt', 'src/a.txt')]), file('b.txt', 'b.txt')],
};

/** The tree with `src` already expanded, so `a.txt` and `b.txt` are both rows. */
function rows() {
  return flattenTree(root, new Set(['src']), 'all');
}

describe('CompareTree', () => {
  it('on a desktop, a single click selects a row and a double-click opens it', async () => {
    stubViewport({ width: 1280, height: 800 });
    const onOpen = vi.fn();
    render(<CompareTree rows={rows()} onToggle={() => undefined} onOpen={onOpen} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('treeitem', { name: 'b.txt' }));
    expect(onOpen).not.toHaveBeenCalled();
    await user.dblClick(screen.getByRole('treeitem', { name: 'b.txt' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'b.txt' }));
  });

  it('on a touch screen, one tap opens a file', () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const onOpen = vi.fn();
    render(<CompareTree rows={rows()} onToggle={() => undefined} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'b.txt' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'b.txt' }));
  });

  it('on a touch screen, one tap on a folder expands or collapses it instead of opening it', () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(<CompareTree rows={rows()} onToggle={onToggle} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ path: 'src' }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
