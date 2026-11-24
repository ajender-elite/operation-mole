import type { CommitPatch, GitLog, GitLogRequest, GitShowRequest } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const SHA = 'd'.repeat(40);
const PARENT = 'e'.repeat(40);
const BOTTOM = 'f'.repeat(40);

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

let showRequest: GitShowRequest | undefined;
let logRequest: GitLogRequest | undefined;

beforeEach(() => {
  showRequest = undefined;
  logRequest = undefined;
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/show', async ({ request }) => {
      showRequest = (await request.json()) as GitShowRequest;
      return HttpResponse.json(patch);
    }),
    http.post('*/api/git/log', async ({ request }) => {
      logRequest = (await request.json()) as GitLogRequest;
      return HttpResponse.json<GitLog>({
        include: { commit: SHA, ref: SHA, label: 'app' },
        commits: [
          {
            ...patch.details,
            body: 'The parser now rejects trailing commas.\nSee https://example.com/issue/7 for the report.',
            files: [],
          },
        ],
        hasMore: false,
        total: 1,
      });
    }),
  );
});

const url = `/u/karthik/s/s1/commit?repo=r1&commit=${SHA}`;

describe('Commit tab', () => {
  it('shows the commit it was opened for: subject, author, dates and parents', async () => {
    renderApp(url);
    expect(await screen.findByRole('heading', { name: /Tighten the parser/ })).toBeVisible();
    expect(screen.getByText(/authored/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Open parent ${PARENT.slice(0, 8)}` })).toBeVisible();
    expect(showRequest).toMatchObject({ source: { type: 'git', repoId: 'r1', branch: SHA } });
  });

  it('shows the full message, with its links', async () => {
    renderApp(url);
    expect(await screen.findByText(/rejects trailing commas/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'https://example.com/issue/7' });
    expect(link).toHaveAttribute('href', 'https://example.com/issue/7');
    expect(logRequest).toMatchObject({ source: { branch: SHA }, limit: 1, withBody: true });
  });

  it('lists the changed files with their line counts and jumps to one', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderApp(url);
    const summary = await screen.findByRole('navigation', { name: 'Files changed' });
    expect(
      within(summary).getByRole('button', { name: /src\/parser\.ts.*\+1/ }),
    ).toBeInTheDocument();
    await userEvent.setup().click(within(summary).getByRole('button', { name: /src\/parser\.ts/ }));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('filters the files by name', async () => {
    renderApp(url);
    await screen.findByRole('region', { name: 'File src/parser.ts' });
    await userEvent.setup().type(screen.getByRole('searchbox', { name: 'Filter files' }), 'logo');
    expect(screen.queryByRole('region', { name: 'File src/parser.ts' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'File assets/logo.png' })).toBeInTheDocument();
  });

  it('collapses a file to its heading, and expands it again', async () => {
    const user = userEvent.setup();
    renderApp(url);
    const modified = await screen.findByRole('region', { name: 'File src/parser.ts' });
    expect(modified).toHaveTextContent('let x = 1;');
    await user.click(within(modified).getByRole('button', { name: 'Collapse src/parser.ts' }));
    expect(modified).not.toHaveTextContent('let x = 1;');
    await user.click(within(modified).getByRole('button', { name: 'Expand src/parser.ts' }));
    expect(modified).toHaveTextContent('let x = 1;');
  });

  it('shows each file side by side by default and can switch to inline', async () => {
    renderApp(url);
    const modified = await screen.findByRole('region', { name: 'File src/parser.ts' });
    expect(modified.querySelector('[aria-pressed="true"]')).toHaveTextContent('Side by side');
    await userEvent.setup().click(within(modified).getByRole('button', { name: 'Inline' }));
    expect(modified.querySelector('[aria-pressed="true"]')).toHaveTextContent('Inline');
  });

  it('opens the range from this commit down to the one typed', async () => {
    const user = userEvent.setup();
    const app = renderApp(url);
    await screen.findByRole('heading', { name: /Tighten the parser/ });
    await user.type(screen.getByRole('textbox', { name: 'Range end' }), BOTTOM);
    await user.click(screen.getByRole('button', { name: 'Open range' }));
    await waitFor(() => {
      expect(app.location().pathname).toMatch(/\/commits$/);
    });
    const params = new URLSearchParams(app.location().search);
    expect(params.get('ref')).toBe(SHA);
    expect(params.get('notIn')).toBe(BOTTOM);
  });
});

describe('Commit tab: from this commit', () => {
  it('browses the files at this commit, in a tab of its own', async () => {
    const { router } = renderApp(url);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Browse files at this commit' }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/u/karthik/s/s1/code');
    });
    expect(new URLSearchParams(router.state.location.search).get('ref')).toBe(SHA);
  });

  it('lists the commits from this commit, in a tab of its own', async () => {
    const { router } = renderApp(url);
    await userEvent.click(await screen.findByRole('button', { name: 'Commits from here' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/u/karthik/s/s1/commits');
    });
    expect(new URLSearchParams(router.state.location.search).get('ref')).toBe(SHA);
  });
});

describe('Commit tab: contained in', () => {
  it('lists the branches and tags of every remote that have the commit, and opens one in its Code tab', async () => {
    server.use(
      http.post('*/api/git/contains', () =>
        HttpResponse.json({
          commit: SHA,
          refs: [
            { remote: 'origin', kind: 'branch', name: 'main' },
            { remote: 'upstream', kind: 'branch', name: 'dev' },
            { remote: 'origin', kind: 'tag', name: 'v1.0' },
          ],
        }),
      ),
    );
    const { router } = renderApp(url);
    await userEvent.click(await screen.findByRole('button', { name: 'upstream/dev' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/u/karthik/s/s1/code');
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('ref')).toBe('dev');
    expect(params.get('remote')).toBe('upstream');
  });
});
