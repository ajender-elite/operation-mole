import type {
  CompareNode,
  DirectoryCompareResult,
  DivergenceCommit,
  SnapshotFileDiff,
  SnapshotFileDiffRequest,
} from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * The git investigation flow in Folders: attribution follows focus from the repository to a
 * folder, a file, a hunk and a line; a commit leads back to the differences it accounts for.
 */

const LEFT_SHA = '1'.repeat(40);
const RIGHT_SHA = '2'.repeat(40);
const sha = (c: string) => c.repeat(40);

const commit = (
  c: string,
  subject: string,
  inLeft: boolean,
  inRight: boolean,
): DivergenceCommit => ({
  sha: sha(c),
  subject,
  authorName: `Author ${c.toUpperCase()}`,
  authorEmail: `${c}@example.com`,
  authorDate: '2026-01-01T10:00:00Z',
  committerName: `Author ${c.toUpperCase()}`,
  committerEmail: `${c}@example.com`,
  commitDate: '2026-01-01T10:00:00Z',
  inLeft,
  inRight,
});
const A = commit('a', 'A: shared history', true, true);
const B = commit('b', 'B: add extra', false, true);
const C = commit('c', 'C: change value', false, true);
const D = commit('d', 'D: add hal', false, true);
const E = commit('e', 'E: base-only docs', true, false);

const file = () => ({ kind: 'file' as const, size: 10, mtimeMs: 0 });
const dir = () => ({ kind: 'directory' as const, size: 0, mtimeMs: 0 });

const root: CompareNode = {
  name: '',
  path: '',
  status: 'modified',
  left: dir(),
  right: dir(),
  children: [
    {
      name: 'audio',
      path: 'audio',
      status: 'modified',
      left: dir(),
      right: dir(),
      children: [
        {
          name: 'hal',
          path: 'audio/hal',
          status: 'modified',
          left: dir(),
          right: dir(),
          children: [
            { name: 'Hal.cpp', path: 'audio/hal/Hal.cpp', status: 'only-right', right: file() },
          ],
        },
        {
          name: 'Stream.cpp',
          path: 'audio/Stream.cpp',
          status: 'modified',
          left: file(),
          right: file(),
        },
      ],
    },
    {
      name: 'docs',
      path: 'docs',
      status: 'modified',
      left: dir(),
      right: dir(),
      children: [
        {
          name: 'readme.md',
          path: 'docs/readme.md',
          status: 'modified',
          left: file(),
          right: file(),
        },
      ],
    },
    {
      name: 'new.txt',
      path: 'new.txt',
      status: 'only-right',
      right: file(),
      renamedFrom: 'old.txt',
      similarity: 100,
    },
    {
      name: 'old.txt',
      path: 'old.txt',
      status: 'only-left',
      left: file(),
      renamedTo: 'new.txt',
      similarity: 100,
    },
    { name: 'same.txt', path: 'same.txt', status: 'identical', left: file(), right: file() },
  ],
};

const result = (tree: CompareNode): DirectoryCompareResult => ({
  left: '/wt/main',
  right: '/wt/dev',
  leftLabel: 'app @ main',
  rightLabel: 'app @ dev',
  root: tree,
  summary: { identical: 1, modified: 2, onlyLeft: 1, onlyRight: 2, errors: 0 },
  leftSnapshot: { commit: LEFT_SHA, ref: 'main' },
  rightSnapshot: { commit: RIGHT_SHA, ref: 'dev' },
});

const diffs: Record<string, SnapshotFileDiff> = {
  'audio/Stream.cpp': {
    leftCommit: LEFT_SHA,
    rightCommit: RIGHT_SHA,
    leftPath: 'audio/Stream.cpp',
    rightPath: 'audio/Stream.cpp',
    content: 'text',
    commits: [A, B, C],
    hunks: [
      {
        header: '@@ -1,2 +1,3 @@',
        leftStart: 1,
        leftCount: 2,
        rightStart: 1,
        rightCount: 3,
        lines: [
          { kind: 'context', text: 'head', leftLine: 1, rightLine: 1 },
          { kind: 'removed', text: 'value = 10', leftLine: 2, commit: A.sha },
          { kind: 'added', text: 'value = 20', rightLine: 2, commit: C.sha },
          { kind: 'added', text: 'extra', rightLine: 3, commit: B.sha },
        ],
      },
      {
        header: '@@ -9 +10,2 @@',
        leftStart: 9,
        leftCount: 1,
        rightStart: 10,
        rightCount: 2,
        lines: [
          { kind: 'context', text: 'tail', leftLine: 9, rightLine: 10 },
          { kind: 'added', text: 'more', rightLine: 11, commit: B.sha },
        ],
      },
    ],
  },
  'audio/hal/Hal.cpp': {
    leftCommit: LEFT_SHA,
    rightCommit: RIGHT_SHA,
    rightPath: 'audio/hal/Hal.cpp',
    content: 'text',
    commits: [D],
    hunks: [
      {
        header: '@@ -0,0 +1 @@',
        leftStart: 0,
        leftCount: 0,
        rightStart: 1,
        rightCount: 1,
        lines: [{ kind: 'added', text: 'hal', rightLine: 1, commit: D.sha }],
      },
    ],
  },
  'docs/readme.md': {
    leftCommit: LEFT_SHA,
    rightCommit: RIGHT_SHA,
    leftPath: 'docs/readme.md',
    rightPath: 'docs/readme.md',
    content: 'text',
    commits: [E, A],
    hunks: [
      {
        header: '@@ -1 +1 @@',
        leftStart: 1,
        leftCount: 1,
        rightStart: 1,
        rightCount: 1,
        lines: [
          { kind: 'removed', text: 'TWO', leftLine: 1, commit: E.sha },
          { kind: 'added', text: 'two', rightLine: 1, commit: A.sha },
        ],
      },
    ],
  },
  'old.txt': {
    leftCommit: LEFT_SHA,
    rightCommit: RIGHT_SHA,
    leftPath: 'old.txt',
    rightPath: 'new.txt',
    content: 'identical',
    commits: [],
    hunks: [],
  },
};

let tree: CompareNode;
let diffRequests: SnapshotFileDiffRequest[];

beforeEach(() => {
  tree = root;
  diffRequests = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/compare/directories', () => HttpResponse.json(result(tree))),
    http.post('*/api/snapshot/file-diff', async ({ request }) => {
      const body = (await request.json()) as SnapshotFileDiffRequest;
      diffRequests.push(body);
      const key = body.leftPath ?? body.rightPath ?? '';
      const found = diffs[key] ?? {
        leftCommit: LEFT_SHA,
        rightCommit: RIGHT_SHA,
        ...(body.leftPath === undefined ? {} : { leftPath: body.leftPath }),
        ...(body.rightPath === undefined ? {} : { rightPath: body.rightPath }),
        content: 'text',
        commits: [B],
        hunks: [
          {
            header: '@@ -1 +1 @@',
            leftStart: 1,
            leftCount: 1,
            rightStart: 1,
            rightCount: 1,
            lines: [{ kind: 'added', text: key, rightLine: 1, commit: B.sha }],
          },
        ],
      };
      return HttpResponse.json(found);
    }),
  );
});

const FOLDERS = `/u/${USER}/s/s1/folders?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev`;
const panel = () => screen.getByRole('complementary', { name: 'Attribution' });
const commitList = () => within(panel()).findByRole('list', { name: 'Divergence commits' });
const subjects = async () =>
  within(await commitList())
    .getAllByRole('button')
    .map((b) => /[A-E]: [a-z -]+/.exec(b.textContent)?.[0]);

describe('git comparisons in Folders', () => {
  it('shows each side’s resolved commit and attributes the whole repository', async () => {
    renderApp(FOLDERS);
    const labels = await screen.findByTestId('column-labels');
    expect(labels).toHaveTextContent('app @ main11111111');
    expect(labels).toHaveTextContent('app @ dev22222222');
    expect(within(panel()).getByText('Repository')).toBeInTheDocument();
    await waitFor(async () => {
      expect((await subjects()).sort()).toEqual(
        [
          'A: shared history',
          'B: add extra',
          'C: change value',
          'D: add hal',
          'E: base-only docs',
        ].sort(),
      );
    });
    // The rename is diffed as one pair (old.txt → new.txt), not twice.
    expect(diffRequests.filter((r) => r.rightPath === 'new.txt')).toEqual([
      expect.objectContaining({ leftPath: 'old.txt', rightPath: 'new.txt' }),
    ]);
  });

  it('narrows attribution to the focused folder', async () => {
    const user = userEvent.setup();
    renderApp(FOLDERS);
    await user.click(await screen.findByRole('treeitem', { name: 'docs' }));
    expect(within(panel()).getByText('Folder')).toBeInTheDocument();
    await waitFor(async () => {
      expect((await subjects()).sort()).toEqual(['A: shared history', 'E: base-only docs']);
    });
    expect(within(panel()).getByText('In both histories')).toBeInTheDocument();
    expect(within(panel()).getByText('Base history only')).toBeInTheDocument();
  });

  it('shows renames as linked entries', async () => {
    renderApp(FOLDERS);
    expect(await screen.findByRole('treeitem', { name: 'old.txt' })).toHaveTextContent(
      'renamed → new.txt',
    );
    expect(screen.getByRole('treeitem', { name: 'new.txt' })).toHaveTextContent(
      'renamed from old.txt',
    );
  });

  it('opens a file in place, then narrows from file to hunk to line', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${FOLDERS}&path=audio`);
    await user.dblClick(await screen.findByRole('treeitem', { name: 'Stream.cpp' }));
    expect(app.search().get('file')).toBe('audio/Stream.cpp');
    expect(app.search().get('path')).toBe('audio');
    const diff = await screen.findByRole('region', { name: 'Snapshot diff' });
    expect(within(panel()).getByText('File')).toBeInTheDocument();
    await waitFor(async () => {
      expect((await subjects()).sort()).toEqual([
        'A: shared history',
        'B: add extra',
        'C: change value',
      ]);
    });

    await user.click(screen.getByRole('button', { name: '@@ -9 +10,2 @@' }));
    expect(app.search().get('hunk')).toBe('1');
    expect(within(panel()).getByText('Hunk')).toBeInTheDocument();
    expect(await subjects()).toEqual(['B: add extra']);

    await user.click(within(diff).getByText('value = 20'));
    expect(within(panel()).getByText('Line')).toBeInTheDocument();
    expect(await subjects()).toEqual(['C: change value']);

    await user.click(screen.getByRole('button', { name: /^folder$/i }));
    expect(app.search().has('file')).toBe(false);
    expect(await screen.findByRole('treeitem', { name: 'Stream.cpp' })).toBeInTheDocument();
  });

  it('goes from a commit to every difference it accounts for', async () => {
    const user = userEvent.setup();
    const app = renderApp(FOLDERS);
    // Let the repository attribution finish so every file is analyzed.
    await waitFor(async () => {
      expect(await subjects()).toHaveLength(5);
    });
    await user.click(within(await commitList()).getByRole('button', { name: /B: add extra/ }));
    expect(app.search().get('commit')).toBe(B.sha);
    const details = within(panel()).getByLabelText('Commit details');
    expect(details).toHaveTextContent(B.sha);
    expect(details).toHaveTextContent('Target history only');
    const where = within(details).getByRole('region', {
      name: /differences this commit accounts for/i,
    });
    expect(
      within(where).getByRole('button', { name: /audio\/Stream\.cpp.*2 lines · 2 hunks/ }),
    ).toBeInTheDocument();

    expect(screen.getByRole('treeitem', { name: 'audio' })).toHaveAttribute(
      'data-highlighted',
      'true',
    );
    expect(screen.getByRole('treeitem', { name: 'docs' })).not.toHaveAttribute('data-highlighted');

    await user.click(within(where).getByRole('button', { name: /audio\/Stream\.cpp/ }));
    expect(app.search().get('file')).toBe('audio/Stream.cpp');
    expect(app.search().get('hunk')).toBe('0');
    const diff = await screen.findByRole('region', { name: 'Snapshot diff' });
    const lines = diff.querySelectorAll(`[data-commit="${B.sha}"]`);
    expect(lines).toHaveLength(2);
  });

  it('restores file, hunk and commit from the URL', async () => {
    renderApp(`${FOLDERS}&file=audio%2FStream.cpp&hunk=0&commit=${C.sha}`);
    expect(await screen.findByRole('button', { name: '@@ -1,2 +1,3 @@' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await within(panel()).findByLabelText('Commit details')).toHaveTextContent(
      'C: change value',
    );
  });

  it('waits for a click before attributing a large folder', async () => {
    const user = userEvent.setup();
    tree = {
      ...root,
      children: Array.from({ length: 45 }, (_, i) => ({
        name: `f${i}.txt`,
        path: `f${i}.txt`,
        status: 'modified' as const,
        left: file(),
        right: file(),
      })),
    };
    renderApp(FOLDERS);
    const aside = await screen.findByRole('complementary', { name: 'Attribution' });
    const start = await within(aside).findByRole('button', { name: 'Attribute 45 files' });
    expect(diffRequests).toEqual([]);
    await user.click(start);
    // 45 diffs, 4 at a time: allow for a loaded machine.
    await waitFor(
      () => {
        expect(diffRequests).toHaveLength(45);
      },
      { timeout: 10_000 },
    );
    expect(await subjects()).toEqual(['B: add extra']);
  });
});
