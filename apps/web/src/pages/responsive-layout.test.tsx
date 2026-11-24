import type {
  ApplicabilityResult,
  SnapshotFileDiff,
  UpstreamCommit,
  GitAncestry,
  GitLog,
  GitResolve,
} from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { fileDiffHandlers } from '../test/file-diff-handlers.ts';
import { server } from '../test/server.ts';
import { stubViewport } from '../test/setup.ts';

// Applicability is composed in the browser (lib/applicability.test.ts covers how); this answers with a fixture.
vi.mock('../lib/applicability.ts', () => ({
  loadApplicability: () => Promise.resolve(applicability),
}));

const UP = 'a'.repeat(40);
const DOWN = 'd'.repeat(40);
const L = '1'.repeat(40);
const R = '2'.repeat(40);
const C1 = 'c'.repeat(40);

const commit: UpstreamCommit = {
  sha: C1,
  subject: 'Add feature',
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-02T00:00:00Z',
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate: '2026-01-02T00:00:00Z',
  parents: ['e'.repeat(40)],
  reachableFromDownstream: false,
};

const applicability: ApplicabilityResult = {
  commit: C1,
  downstreamCommit: DOWN,
  status: 'clean',
  reason: 'applies',
  baseParent: 'e'.repeat(40),
  isMerge: false,
  files: [],
  equivalentCommits: [],
  conflicts: [],
  messages: [],
};

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
    http.post('*/api/git/log', () =>
      HttpResponse.json<GitLog>({
        include: { commit: UP, ref: 'main', label: 'app @ main' },
        exclude: { commit: DOWN, ref: 'product', label: 'app @ product' },
        commits: [commit],
        hasMore: false,
        total: 1,
      }),
    ),
    http.post('*/api/git/ancestry', () => HttpResponse.json<GitAncestry>({ results: [] })),
    ...fileDiffHandlers(() => diff),
  );
});

const UPSTREAM = `/u/${USER}/s/s1/upstream?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=product`;
const FILE = `/u/${USER}/s/s1/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=product&leftCommit=${L}&rightCommit=${R}&leftPath=a.txt&rightPath=a.txt`;

describe('Upstream once compared', () => {
  it('shows the sources as a read-only summary, with no form to change them', async () => {
    renderApp(UPSTREAM);
    const compared = await screen.findByRole('group', { name: 'Compared' });
    expect(within(compared).getByText(/main/)).toBeInTheDocument();
    expect(within(compared).getByRole('link', { name: 'New comparison' })).toHaveAttribute(
      'href',
      `/u/${USER}/s/s1`,
    );
    expect(screen.queryByRole('button', { name: 'Analyze' })).not.toBeInTheDocument();
  });
});

describe('Upstream commit details on a phone', () => {
  it('opens as a dialog over the list, and Escape returns to the list', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const app = renderApp(`${UPSTREAM}&commit=${C1}`);
    const dialog = await screen.findByRole('dialog', { name: 'Commit applicability' });
    expect(dialog).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(app.search().get('commit')).toBeNull();
    });
  });

  it('is hidden on a phone until a commit is chosen, so the list keeps the screen', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    renderApp(UPSTREAM);
    const dialog = await screen.findByRole('dialog', { name: 'Commit applicability' });
    expect(dialog).toHaveClass('max-lg:hidden');
    expect(screen.getByRole('list', { name: 'Upstream commits' })).toBeVisible();
  });
});

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

describe('Upstream window on a phone in landscape', () => {
  it('folds the window settings into one line that expands on tap', async () => {
    stubViewport({ width: 844, height: 390, pointer: 'coarse' });
    const user = userEvent.setup();
    renderApp(UPSTREAM);
    const toggle = await screen.findByRole('button', { name: /window: last/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Number of commits')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByLabelText('Number of commits')).toBeInTheDocument();
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
