import type { DiffHunk, SnapshotFileDiff } from '@om/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlameMark } from '../lib/blame.ts';
import { alignRows } from '../lib/diff-rows.ts';
import { SnapshotDiffView, type DiffLayout } from './snapshot-diff-view.tsx';

const hunk: DiffHunk = {
  header: '@@ -1,4 +1,4 @@',
  leftStart: 1,
  leftCount: 4,
  rightStart: 1,
  rightCount: 4,
  lines: [
    { kind: 'context', text: 'keep', leftLine: 1, rightLine: 1 },
    { kind: 'removed', text: 'old a', leftLine: 2, commit: 'c-old-a' },
    { kind: 'removed', text: 'old b', leftLine: 3, commit: 'c-old-b' },
    { kind: 'added', text: 'new a', rightLine: 2, commit: 'c-new-a' },
    { kind: 'added', text: 'new b', rightLine: 3, commit: 'c-new-b' },
    { kind: 'added', text: 'new c', rightLine: 4, commit: 'c-new-c' },
    { kind: 'context', text: 'end', leftLine: 4, rightLine: 5 },
  ],
};

const diff: SnapshotFileDiff = {
  leftCommit: 'L',
  rightCommit: 'R',
  leftPath: 'f.txt',
  rightPath: 'f.txt',
  content: 'text',
  hunks: [hunk],
  commits: [
    {
      sha: 'c-old-a',
      subject: 'old commit',
      authorName: 'A',
      authorEmail: 'a@x',
      authorDate: '2026-01-01T00:00:00Z',
      committerName: 'A',
      committerEmail: 'a@x',
      commitDate: '2026-01-01T00:00:00Z',
      inLeft: true,
      inRight: false,
    },
  ],
};

/** The blame of a side: line 1 of the left file was last changed by one commit. */
const leftBlame = new Map<number, BlameMark>([
  [
    1,
    {
      sha: 'b-left',
      subject: 'Last left change',
      authorName: 'Ada',
      authorDate: '2026-01-01T00:00:00Z',
      isShared: false,
    },
  ],
]);

describe('blame markers', () => {
  const renderWithBlame = (
    blame: { left?: ReadonlyMap<number, BlameMark> },
    layout: DiffLayout,
  ) => {
    const onOpenCommit = vi.fn();
    render(
      <SnapshotDiffView
        diff={diff}
        leftLabel="Left"
        rightLabel="Right"
        focusedHunk={undefined}
        focusedLine={undefined}
        highlightCommit={undefined}
        layout={layout}
        onFocusHunk={() => undefined}
        onFocusLine={() => undefined}
        onOpenCommit={onOpenCommit}
        blame={blame}
      />,
    );
    return { onOpenCommit };
  };

  it('marks the line of a side it blames, context lines included, and opens its commit', () => {
    const { onOpenCommit } = renderWithBlame({ left: leftBlame }, 'side');
    const marker = screen.getByRole('button', { name: 'Last change in Left: Last left change' });
    fireEvent.click(marker);
    expect(onOpenCommit).toHaveBeenCalledWith('b-left', 'left');
  });

  it('shows the same marker in the inline view', () => {
    renderWithBlame({ left: leftBlame }, 'inline');
    expect(
      screen.getByRole('button', { name: 'Last change in Left: Last left change' }),
    ).toBeInTheDocument();
  });

  it('says a shared commit is shared, with a dashed marker', () => {
    const shared = new Map<number, BlameMark>([
      [
        1,
        {
          sha: 'b-left',
          subject: 'Shared',
          authorName: 'Ada',
          authorDate: '2026-01-01T00:00:00Z',
          isShared: true,
        },
      ],
    ]);
    renderWithBlame({ left: shared }, 'side');
    expect(screen.getByRole('button', { name: 'Last change in Left: Shared' })).toHaveClass(
      'border-dashed',
    );
  });
});

describe('alignRows', () => {
  it('pairs removed and added lines of one change block, row by row', () => {
    const rows = alignRows(hunk);
    expect(rows.map((r) => [r.left?.line.text, r.right?.line.text])).toEqual([
      ['keep', 'keep'],
      ['old a', 'new a'],
      ['old b', 'new b'],
      [undefined, 'new c'],
      ['end', 'end'],
    ]);
  });

  it('keeps the index of each line within the hunk, for focus', () => {
    const rows = alignRows(hunk);
    expect(rows[2]?.left?.index).toBe(2);
    expect(rows[2]?.right?.index).toBe(4);
    expect(rows[3]?.left).toBeUndefined();
  });

  it('shows a pure deletion or insertion on one side only', () => {
    const only: DiffHunk = {
      ...hunk,
      lines: [
        { kind: 'removed', text: 'gone', leftLine: 1 },
        { kind: 'context', text: 'same', leftLine: 2, rightLine: 1 },
        { kind: 'added', text: 'fresh', rightLine: 2 },
      ],
    };
    expect(alignRows(only).map((r) => [r.left?.line.text, r.right?.line.text])).toEqual([
      ['gone', undefined],
      ['same', 'same'],
      [undefined, 'fresh'],
    ]);
  });
});

describe('SnapshotDiffView layout', () => {
  const renderView = (layout: DiffLayout | undefined, onLayoutChange = vi.fn()) => {
    const onFocusLine = vi.fn();
    render(
      <SnapshotDiffView
        diff={diff}
        leftLabel="app @ main (aaaaaaa)"
        rightLabel="app @ dev (bbbbbbb)"
        focusedHunk={undefined}
        focusedLine={undefined}
        highlightCommit={undefined}
        layout={layout}
        onLayoutChange={onLayoutChange}
        onFocusHunk={vi.fn()}
        onFocusLine={onFocusLine}
        onOpenCommit={vi.fn()}
      />,
    );
    return { onLayoutChange, onFocusLine };
  };

  it('opens side by side by default, with Left on the left and Right on the right', () => {
    renderView(undefined);
    const region = screen.getByRole('region', { name: 'Snapshot diff' });
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(region).getByRole('columnheader', { name: 'Left' })).toBeInTheDocument();
    expect(within(region).getByRole('columnheader', { name: 'Right' })).toBeInTheDocument();
    expect(screen.getByText('app @ main (aaaaaaa)')).toBeInTheDocument();
    expect(screen.getByText('app @ dev (bbbbbbb)')).toBeInTheDocument();
  });

  it('switches to inline and reports the choice, keeping the same lines', () => {
    const { onLayoutChange } = renderView('side');
    fireEvent.click(screen.getByRole('button', { name: 'Inline' }));
    expect(onLayoutChange).toHaveBeenCalledWith('inline');
  });

  it('renders the inline layout as one list with +/- markers', () => {
    renderView('inline');
    const region = screen.getByRole('region', { name: 'Snapshot diff' });
    expect(within(region).queryByRole('columnheader', { name: 'Left' })).not.toBeInTheDocument();
    expect(region.querySelectorAll('[data-kind="added"]')).toHaveLength(3);
    expect(region.querySelectorAll('[data-kind="removed"]')).toHaveLength(2);
  });

  it('focuses a changed line by its hunk and index, from either side', () => {
    const { onFocusLine } = renderView('side');
    fireEvent.click(screen.getByText('old b'));
    expect(onFocusLine).toHaveBeenLastCalledWith({ hunk: 0, line: 2 });
    fireEvent.click(screen.getByText('new c'));
    expect(onFocusLine).toHaveBeenLastCalledWith({ hunk: 0, line: 5 });
  });

  it('opens a commit in its own tab from the commit marker, not by selecting it', () => {
    const onOpenCommit = vi.fn();
    render(
      <SnapshotDiffView
        diff={diff}
        leftLabel="a"
        rightLabel="b"
        focusedHunk={undefined}
        focusedLine={undefined}
        highlightCommit={undefined}
        layout="side"
        onLayoutChange={vi.fn()}
        onFocusHunk={vi.fn()}
        onFocusLine={vi.fn()}
        onOpenCommit={onOpenCommit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Commit c-old-a: old commit/ }));
    expect(onOpenCommit).toHaveBeenCalledWith('c-old-a', 'left');
  });
});

describe('syntax highlighting', () => {
  it('colours each token of a line with its palette colour, in either layout', () => {
    const keyword = { content: 'keep', color: 'var(--color-syntax-token-keyword)' };
    const tokens = [[[keyword], [], [], [], [], [], []]];
    const onOpenCommit = vi.fn();
    const { rerender } = render(
      <SnapshotDiffView
        diff={diff}
        leftLabel="Left"
        rightLabel="Right"
        focusedHunk={undefined}
        focusedLine={undefined}
        highlightCommit={undefined}
        layout="side"
        onFocusHunk={() => undefined}
        onFocusLine={() => undefined}
        onOpenCommit={onOpenCommit}
        tokens={tokens}
      />,
    );
    const sideBySide = screen.getAllByText('keep');
    expect(
      sideBySide.some((el) =>
        (el.getAttribute('style') ?? '').includes('--color-syntax-token-keyword'),
      ),
    ).toBe(true);
    rerender(
      <SnapshotDiffView
        diff={diff}
        leftLabel="Left"
        rightLabel="Right"
        focusedHunk={undefined}
        focusedLine={undefined}
        highlightCommit={undefined}
        layout="inline"
        onFocusHunk={() => undefined}
        onFocusLine={() => undefined}
        onOpenCommit={onOpenCommit}
        tokens={tokens}
      />,
    );
    expect(
      screen.getByText('keep').getAttribute('style')?.includes('--color-syntax-token-keyword'),
    ).toBe(true);
  });
});
