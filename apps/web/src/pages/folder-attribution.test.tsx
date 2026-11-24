import type { CompareNode, FolderComparison, DivergenceCommit, SnapshotFileDiff } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';
import { fileDiffHandlers } from '../test/file-diff-handlers.ts';

/*
 * The investigation flow: Folder Compare shows what differs; what accounts for it is computed
 * only when asked, scoped to what the user is looking at (the comparison, a folder, a file, a
 * hunk, a line). Files open in their own tab, and tabs keep their state.
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

const result = (tree: CompareNode): FolderComparison => ({
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
let diffRequests: Array<{ leftPath?: string | undefined; rightPath?: string | undefined }>;
/** Files whose changed lines were asked to be blamed (the attributed ones). */
let blamedPaths: string[];

beforeEach(() => {
  tree = root;
  diffRequests = [];
  blamedPaths = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/compare-trees', () =>
      HttpResponse.json({
        left: { commit: 'a'.repeat(40), ref: 'main', label: 'main' },
        right: { commit: 'b'.repeat(40), ref: 'dev', label: 'dev' },
        entries: [],
        renames: [],
        folder: result(tree),
      }),
    ),
    ...fileDiffHandlers(
      ({ leftPath, rightPath }) => {
        diffRequests.push({ leftPath, rightPath });
        const key = leftPath ?? rightPath ?? '';
        return (
          diffs[key] ?? {
            leftCommit: LEFT_SHA,
            rightCommit: RIGHT_SHA,
            ...(leftPath === undefined ? {} : { leftPath }),
            ...(rightPath === undefined ? {} : { rightPath }),
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
          }
        );
      },
      {
        onBlame: (path) => {
          blamedPaths.push(path);
        },
      },
    ),
  );
});

const BASE = `/u/${USER}/s/s1`;
const FOLDERS = `${BASE}/folders?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev`;
const FILE = (path: string, extra = '') =>
  `${BASE}/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev&leftCommit=${LEFT_SHA}&rightCommit=${RIGHT_SHA}&leftPath=${encodeURIComponent(path)}&rightPath=${encodeURIComponent(path)}${extra}`;
const panel = () => screen.getByRole('complementary', { name: 'Attribution' });
const commitList = () => within(panel()).findByRole('list', { name: 'Divergence commits' });
const subjects = async () =>
  within(await commitList())
    .getAllByRole('button')
    .map((b) => /[A-E]: [a-z -]+/.exec(b.textContent)?.[0]);
const attributed = () => [...new Set(blamedPaths)];

describe('explaining differences on demand', () => {
  it('shows what is different first, without attributing anything', async () => {
    renderApp(FOLDERS);
    const labels = await screen.findByTestId('column-labels');
    expect(labels).toHaveTextContent('app @ main11111111');
    expect(labels).toHaveTextContent('app @ dev22222222');
    expect(await screen.findByRole('treeitem', { name: 'audio' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Attribution' })).not.toBeInTheDocument();
    expect(diffRequests).toEqual([]);
  });

  it('explains the whole comparison when asked', async () => {
    const user = userEvent.setup();
    const app = renderApp(FOLDERS);
    await user.click(await screen.findByRole('button', { name: 'Explain differences here' }));
    expect(app.search().get('explain')).toBe('/');
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

  it('explains only the focused folder, from its row', async () => {
    const user = userEvent.setup();
    renderApp(FOLDERS);
    const docs = await screen.findByRole('treeitem', { name: 'docs' });
    await user.click(within(docs).getByRole('button', { name: 'Explain difference' }));
    expect(within(panel()).getByText('Folder')).toBeInTheDocument();
    await waitFor(async () => {
      expect((await subjects()).sort()).toEqual(['A: shared history', 'E: base-only docs']);
    });
    expect(within(panel()).getByText('In both histories')).toBeInTheDocument();
    expect(within(panel()).getByText('Left history only')).toBeInTheDocument();
    // Nothing outside the folder was analyzed.
    expect(attributed()).toEqual(['docs/readme.md']);
  });

  it('puts the explanation away again', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${FOLDERS}&explain=docs%2F`);
    const aside = await screen.findByRole('complementary', { name: 'Attribution' });
    await user.click(within(aside).getByRole('button', { name: 'Close explanation' }));
    expect(screen.queryByRole('complementary', { name: 'Attribution' })).not.toBeInTheDocument();
    expect(app.search().has('explain')).toBe(false);
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

  it('opens a file in its own tab with just the difference, then narrows the explanation from file to hunk to line', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${FOLDERS}&path=audio`);
    await user.dblClick(await screen.findByRole('treeitem', { name: 'Stream.cpp' }));
    await waitFor(() => {
      expect(app.location().pathname).toBe(`${BASE}/file`);
    });
    const diff = await screen.findByRole('region', { name: 'Snapshot diff' });
    expect(within(diff).getByText('value = 20')).toBeInTheDocument();
    expect(diff.querySelectorAll('[data-commit]')).toHaveLength(0);
    expect(screen.queryByRole('complementary', { name: 'Attribution' })).not.toBeInTheDocument();
    expect(attributed()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Explain difference' }));
    expect(app.search().get('explain')).toBe('1');
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
  });

  it('goes from a commit to every difference it accounts for', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${FOLDERS}&explain=%2F`);
    // Let the repository attribution finish so every file is analyzed.
    await waitFor(async () => {
      expect(await subjects()).toHaveLength(5);
    });
    await user.click(within(await commitList()).getByRole('button', { name: /B: add extra/ }));
    expect(app.search().get('commit')).toBe(B.sha);
    const details = within(panel()).getByLabelText('Commit details');
    expect(details).toHaveTextContent(B.sha);
    expect(details).toHaveTextContent('Right history only');
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
    await waitFor(() => {
      expect(app.location().pathname).toBe(`${BASE}/file`);
    });
    expect(app.search().get('leftPath')).toBe('audio/Stream.cpp');
    expect(app.search().get('hunk')).toBe('0');
    expect(app.search().get('commit')).toBe(B.sha);
    const diff = await screen.findByRole('region', { name: 'Snapshot diff' });
    await waitFor(() => {
      expect(diff.querySelectorAll(`[data-commit="${B.sha}"]`)).toHaveLength(2);
    });
  });

  it('restores a file tab’s explanation, hunk and commit from the URL', async () => {
    renderApp(FILE('audio/Stream.cpp', `&explain=1&hunk=0&commit=${C.sha}`));
    expect(await screen.findByRole('button', { name: '@@ -1,2 +1,3 @@' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await within(panel()).findByLabelText('Commit details')).toHaveTextContent(
      'C: change value',
    );
  });

  it('asks before attributing a large folder, even when asked to explain it', async () => {
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
    await user.click(await screen.findByRole('button', { name: 'Explain differences here' }));
    const start = await within(panel()).findByRole('button', { name: 'Attribute 45 files' });
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
  }, 20_000); // the waitFor above allows 10s; the 5s default test timeout would cut it short
});

describe('working in tabs', () => {
  const tab = (name: RegExp | string) => screen.getByRole('tab', { name });
  const folderTab = () => tab(/app @ main ↔ app @ dev/);

  it('drills into a file and comes back to the folder exactly as it was left', async () => {
    const user = userEvent.setup();
    const app = renderApp(FOLDERS);
    const audio = await screen.findByRole('treeitem', { name: 'audio' });
    await user.click(within(audio).getByRole('button', { name: /expand/i }));
    await user.click(screen.getByRole('radio', { name: /differences only/i }));
    await user.dblClick(await screen.findByRole('treeitem', { name: 'Stream.cpp' }));
    await waitFor(() => {
      expect(tab('Stream.cpp')).toHaveAttribute('aria-selected', 'true');
    });
    expect(await screen.findByRole('region', { name: 'Snapshot diff' })).toBeInTheDocument();

    await user.click(folderTab());
    expect(app.location().pathname).toBe(`${BASE}/folders`);
    expect(screen.getByRole('treeitem', { name: 'audio' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('treeitem', { name: 'Stream.cpp' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /differences only/i })).toBeChecked();
    expect(screen.queryByRole('treeitem', { name: 'same.txt' })).not.toBeInTheDocument();
  });

  it('focuses an open file tab instead of opening the same file twice', async () => {
    const user = userEvent.setup();
    renderApp(`${FOLDERS}&path=audio`);
    await user.dblClick(await screen.findByRole('treeitem', { name: 'Stream.cpp' }));
    await user.click(await screen.findByRole('button', { name: /folder compare/i }));
    expect(folderTab()).toHaveAttribute('aria-selected', 'true');
    await user.dblClick(screen.getByRole('treeitem', { name: 'Stream.cpp' }));
    await waitFor(() => {
      expect(tab('Stream.cpp')).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getAllByRole('tab', { name: 'Stream.cpp' })).toHaveLength(1);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('closing a tab returns to the one before it', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${FOLDERS}&path=audio`);
    await user.dblClick(await screen.findByRole('treeitem', { name: 'Stream.cpp' }));
    await user.click(await screen.findByRole('button', { name: 'Close Stream.cpp' }));
    await waitFor(() => {
      expect(app.location().pathname).toBe(`${BASE}/folders`);
    });
    expect(screen.queryByRole('tab', { name: 'Stream.cpp' })).not.toBeInTheDocument();
    expect(app.search().get('path')).toBe('audio');
  });

  it('reopens a comparison that is already open in its tab, where the user left it', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${FOLDERS}&path=docs`);
    expect(await screen.findByRole('treeitem', { name: 'readme.md' })).toBeInTheDocument();
    await user.click(tab('Overview'));
    const compare = await screen.findByRole('region', { name: 'Compare' });
    for (const [side, branch] of [
      ['Left', 'main'],
      ['Right', 'dev'],
    ] as const) {
      await user.selectOptions(within(compare).getByLabelText(`${side} repository`), 'r1');
      await user.selectOptions(within(compare).getByLabelText(`${side} branch`), branch);
    }
    await user.click(within(compare).getByRole('button', { name: /compare folders/i }));
    await waitFor(() => {
      expect(folderTab()).toHaveAttribute('aria-selected', 'true');
    });
    expect(app.search().get('path')).toBe('docs');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('remembers the open tabs across a reload', async () => {
    const user = userEvent.setup();
    const first = renderApp(`${FOLDERS}&path=audio`);
    await user.dblClick(await screen.findByRole('treeitem', { name: 'Stream.cpp' }));
    await screen.findByRole('tab', { name: 'Stream.cpp' });
    first.unmount();

    renderApp(FOLDERS);
    expect(await screen.findByRole('tab', { name: 'Stream.cpp' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /app @ main ↔ app @ dev/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
