import type { DiffHunk, SnapshotFileDiff } from '@om/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { stubViewport } from '../test/setup.ts';
import { SnapshotDiffView } from './snapshot-diff-view.tsx';

const hunk: DiffHunk = {
  header: '@@ -1,2 +1,2 @@',
  leftStart: 1,
  leftCount: 2,
  rightStart: 1,
  rightCount: 2,
  lines: [
    { kind: 'removed', text: 'old line of a long path', leftLine: 1, commit: 'c-old' },
    { kind: 'added', text: 'new line', rightLine: 1, commit: 'c-new' },
    { kind: 'context', text: 'end', leftLine: 2, rightLine: 2 },
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
      sha: 'c-old',
      subject: 'Rename the greeting',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorDate: '2026-01-02T10:00:00Z',
      committerName: 'Ada Lovelace',
      committerEmail: 'ada@example.com',
      commitDate: '2026-01-02T10:00:00Z',
      inLeft: true,
      inRight: false,
    },
  ],
};

function renderView(props: {
  onOpenCommit?: () => void;
  onWrapChange?: (wrap: boolean) => void;
  wrap?: boolean;
  onFocusHunk?: (h: number) => void;
  onFocusLine?: (l: unknown) => void;
}) {
  render(
    <SnapshotDiffView
      diff={diff}
      leftLabel="app @ main"
      rightLabel="app @ dev"
      focusedHunk={undefined}
      focusedLine={undefined}
      highlightCommit={undefined}
      onFocusHunk={props.onFocusHunk ?? (() => undefined)}
      onFocusLine={(line) => {
        props.onFocusLine?.(line);
      }}
      onOpenCommit={props.onOpenCommit ?? (() => undefined)}
      {...(props.onWrapChange ? { onWrapChange: props.onWrapChange } : {})}
      wrap={props.wrap ?? true}
    />,
  );
}

describe('commit marker on a touch screen', () => {
  it('shows the commit first, and opens it only when Open commit is chosen', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const onOpenCommit = vi.fn();
    renderView({ onOpenCommit });
    fireEvent.click(screen.getByRole('button', { name: /commit c-old/i }));
    const details = screen.getByRole('dialog', { name: 'Commit details' });
    expect(within(details).getByText('Rename the greeting')).toBeInTheDocument();
    expect(within(details).getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(onOpenCommit).not.toHaveBeenCalled();
    await userEvent.setup().click(within(details).getByRole('button', { name: 'Open commit' }));
    expect(onOpenCommit).toHaveBeenCalledTimes(1);
  });

  it('on a desktop, the marker opens the commit straight away', async () => {
    stubViewport({ width: 1280, height: 800 });
    const onOpenCommit = vi.fn();
    renderView({ onOpenCommit });
    await userEvent.setup().click(screen.getByRole('button', { name: /commit c-old/i }));
    expect(onOpenCommit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Commit details' })).not.toBeInTheDocument();
  });
});

describe('changes on a touch screen', () => {
  it('offers Next and Previous change buttons, which stand in for j and k', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const onFocusLine = vi.fn();
    renderView({ onFocusLine });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next change' }));
    expect(onFocusLine).toHaveBeenCalledWith({ hunk: 0, line: 0 });
  });

  it('does not show the change buttons on a desktop, where j and k do the job', () => {
    stubViewport({ width: 1280, height: 800 });
    renderView({});
    expect(screen.queryByRole('button', { name: 'Next change' })).not.toBeInTheDocument();
  });
});

describe('wrap lines', () => {
  it('turns wrapping off to scroll long lines sideways, and reports the choice', async () => {
    stubViewport({ width: 1280, height: 800 });
    const onWrapChange = vi.fn();
    renderView({ onWrapChange, wrap: true });
    const toggle = screen.getByRole('button', { name: 'Wrap lines' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.setup().click(toggle);
    expect(onWrapChange).toHaveBeenCalledWith(false);
  });

  it('keeps long lines on one line when wrapping is off', () => {
    stubViewport({ width: 1280, height: 800 });
    renderView({ onWrapChange: () => undefined, wrap: false });
    const code = screen.getByText('old line of a long path');
    expect(code).toHaveClass('whitespace-pre');
    expect(code).toHaveClass('overflow-x-auto');
  });
});

describe('truncated labels on a touch screen', () => {
  it('shows the full label in a popover when it is tapped', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    renderView({});
    await userEvent.setup().click(screen.getByRole('button', { name: 'app @ main' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('app @ main');
  });
});
