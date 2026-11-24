import type { GitAncestry, GitResolve, SnapshotFileDiff } from '@om/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { fileDiffHandlers } from '../test/file-diff-handlers.ts';
import { server } from '../test/server.ts';
import { stubViewport } from '../test/setup.ts';

const UP = 'a'.repeat(40);
const DOWN = 'd'.repeat(40);
const L = '1'.repeat(40);
const R = '2'.repeat(40);

const diff: SnapshotFileDiff = {
  leftCommit: L,
  rightCommit: R,
  leftPath: 'a.txt',
  rightPath: 'a.txt',
  content: 'text',
  hunks: [
    {
      header: '@@ -1 +1 @@',
      leftStart: 1,
      leftCount: 1,
      rightStart: 1,
      rightCount: 1,
      lines: [
        { kind: 'removed', text: 'old', leftLine: 1 },
        { kind: 'added', text: 'new', rightLine: 1 },
      ],
    },
  ],
  commits: [],
};

beforeEach(() => {
  server.use(
    sessionDetailHandler({ repos: [repoInfo({ branches: ['main', 'product'] })] }),
    http.post('*/api/git/resolve', () =>
      HttpResponse.json<GitResolve>({
        revisions: [
          { commit: UP, ref: 'main', label: 'app @ main' },
          { commit: DOWN, ref: 'product', label: 'app @ product' },
        ],
      }),
    ),
    http.post('*/api/git/ancestry', () => HttpResponse.json<GitAncestry>({ results: [] })),
    ...fileDiffHandlers(() => diff),
  );
});

const FILE = `/u/${USER}/s/s1/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=product&leftCommit=${L}&rightCommit=${R}&leftPath=a.txt&rightPath=a.txt`;

describe('File Compare on a phone', () => {
  it('puts Whole file and the diverging-commit actions behind More', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const user = userEvent.setup();
    renderApp(FILE);
    await screen.findByRole('button', { name: 'More' });
    expect(screen.queryByRole('button', { name: 'Whole file' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Whole file' })).toBeVisible();
  });
});

describe('File Compare layout by screen', () => {
  it('opens inline on a phone held upright, and side by side on a desktop', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const { unmount } = renderApp(FILE);
    expect(await screen.findByRole('button', { name: 'Inline' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    unmount();
    stubViewport({ width: 1280, height: 800 });
    renderApp(FILE);
    expect(await screen.findByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps an explicit choice in the URL, which wins over the screen', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const user = userEvent.setup();
    const app = renderApp(`${FILE}&view=side`);
    expect(await screen.findByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Inline' }));
    await waitFor(() => {
      expect(app.search().get('view')).toBe('inline');
    });
  });

  it('turns off line wrapping through the URL', async () => {
    stubViewport({ width: 1280, height: 800 });
    const user = userEvent.setup();
    const app = renderApp(FILE);
    await user.click(await screen.findByRole('button', { name: 'Wrap lines' }));
    await waitFor(() => {
      expect(app.search().get('wrap')).toBe('0');
    });
  });
});
