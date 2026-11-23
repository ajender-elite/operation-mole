import type { CommitPatch } from '@om/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const SHA = 'd'.repeat(40);
const PARENT = 'e'.repeat(40);

const patch: CommitPatch = {
  commit: SHA,
  details: {
    sha: SHA,
    subject: 'Tighten the parser',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-01-02T00:00:00Z',
    committerName: 'Ada',
    committerEmail: 'ada@example.com',
    commitDate: '2026-01-02T00:00:00Z',
    parents: [PARENT],
  },
  baseParent: PARENT,
  truncated: false,
  files: [
    {
      oldPath: 'src/parser.ts',
      newPath: 'src/parser.ts',
      status: 'modified',
      binary: false,
      hunks: [
        {
          header: '@@ -1 +1 @@',
          leftStart: 1,
          leftCount: 1,
          rightStart: 1,
          rightCount: 1,
          lines: [
            { kind: 'removed', text: 'let x = 1;', leftLine: 1 },
            { kind: 'added', text: 'const x = 1;', rightLine: 1 },
          ],
        },
      ],
    },
    {
      newPath: 'assets/logo.png',
      status: 'added',
      binary: true,
      hunks: [],
    },
  ],
};

let requested: unknown;

beforeEach(() => {
  requested = undefined;
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/upstream/patch', async ({ request }) => {
      requested = await request.json();
      return HttpResponse.json(patch);
    }),
  );
});

const url = `/u/karthik/s/s1/commit?repo=r1&commit=${SHA}`;

describe('Commit tab', () => {
  it('shows the commit it was opened for, with its git metadata and parents', async () => {
    renderApp(url);
    expect(await screen.findByRole('heading', { name: /Tighten the parser/ })).toBeVisible();
    expect(screen.getByText(/authored/)).toBeInTheDocument();
    expect(screen.getByText(/Parent: eeeeeee/)).toBeInTheDocument();
    expect(requested).toMatchObject({
      upstream: { type: 'git', repoId: 'r1', branch: SHA },
      commit: SHA,
    });
  });

  it('shows each changed file, and says when there are no lines to show', async () => {
    renderApp(url);
    const modified = await screen.findByRole('region', { name: 'File src/parser.ts' });
    expect(modified).toHaveTextContent('let x = 1;');
    expect(modified).toHaveTextContent('const x = 1;');
    const binary = screen.getByRole('region', { name: 'File assets/logo.png' });
    expect(binary).toHaveTextContent('Binary file');
  });

  it('shows each file side by side by default and can switch to inline', async () => {
    renderApp(url);
    const modified = await screen.findByRole('region', { name: 'File src/parser.ts' });
    const sideBy = modified.querySelector('[aria-pressed="true"]');
    expect(sideBy).toHaveTextContent('Side by side');
    await userEvent.setup().click(within(modified).getByRole('button', { name: 'Inline' }));
    expect(modified.querySelector('[aria-pressed="true"]')).toHaveTextContent('Inline');
  });
});
