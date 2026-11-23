import type { RecentComparison, RepoInfo } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { dirResult } from '../test/fixtures.ts';
import { USER, repoInfo, sessionSummary } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

let repos: RepoInfo[];
let recent: RecentComparison[];
let added: string[];

beforeEach(() => {
  added = [];
  repos = [repoInfo()];
  recent = [
    {
      id: 'c1',
      left: { type: 'git', repoId: 'r1', branch: 'main' },
      right: { type: 'git', repoId: 'r1', branch: 'dev' },
      leftLabel: 'app @ main',
      rightLabel: 'app @ dev',
      comparedAt: new Date().toISOString(),
    },
    {
      id: 'c2',
      left: { type: 'path', path: '/a' },
      right: { type: 'path', path: '/b' },
      leftLabel: '/a',
      rightLabel: '/b',
      comparedAt: new Date().toISOString(),
    },
  ];
  server.use(
    http.get('*/api/users/:user/sessions/:sessionId', () =>
      HttpResponse.json({ user: USER, session: sessionSummary(), repos, recent }),
    ),
    http.post('*/api/users/:user/sessions/:sessionId/repos', async ({ request }) => {
      const { url } = (await request.json()) as { url: string };
      added.push(url);
      const repo = repoInfo({ id: 'r2', url, name: 'lib' });
      repos = [...repos, repo];
      return HttpResponse.json(repo, { status: 201 });
    }),
    http.post('*/api/compare/directories', () => HttpResponse.json(dirResult)),
    http.post('*/api/upstream/commits', () =>
      HttpResponse.json({ message: 'not needed here' }, { status: 400 }),
    ),
    http.post('*/api/users/:user/sessions/:sessionId/repos/:repoId/fetch', () => {
      repos = repos.map((r) => ({ ...r, branches: [...r.branches, 'hotfix'] }));
      return HttpResponse.json(repos[0]);
    }),
  );
});

const OVERVIEW = `/u/${USER}/s/s1`;

describe('SessionOverviewPage', () => {
  it('with no repository, asks for one and offers nothing else', async () => {
    repos = [];
    recent = [];
    renderApp(OVERVIEW);
    expect(await screen.findByRole('heading', { name: 'Add a repository' })).toBeInTheDocument();
    expect(screen.getByLabelText(/repository url/i)).toHaveFocus();
    expect(screen.queryByRole('region', { name: 'Compare' })).not.toBeInTheDocument();
    expect(screen.queryByText(/recent comparisons/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /compare/i })).not.toBeInTheDocument();
  });

  it('reveals comparing once a repository is added', async () => {
    const user = userEvent.setup();
    repos = [];
    recent = [];
    renderApp(OVERVIEW);
    await user.type(
      await screen.findByLabelText(/repository url/i),
      'https://github.com/acme/lib.git',
    );
    await user.click(screen.getByRole('button', { name: /add repository/i }));
    await waitFor(() => {
      expect(added).toEqual(['https://github.com/acme/lib.git']);
    });
    const compare = await screen.findByRole('region', { name: 'Compare' });
    expect(within(compare).getByLabelText('Base repository')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /repositories/i })).toHaveTextContent('lib');
  });

  it('compares the chosen snapshots in a Folder Compare tab', async () => {
    const user = userEvent.setup();
    const app = renderApp(OVERVIEW);
    const compare = await screen.findByRole('region', { name: 'Compare' });
    // Upstream analysis is offered only once there is something to analyze.
    expect(within(compare).queryByRole('button', { name: /upstream/i })).not.toBeInTheDocument();
    for (const [side, branch] of [
      ['Base', 'main'],
      ['Target', 'dev'],
    ] as const) {
      await user.selectOptions(within(compare).getByLabelText(`${side} repository`), 'r1');
      await user.selectOptions(within(compare).getByLabelText(`${side} branch`), branch);
    }
    expect(within(compare).getByRole('button', { name: /check upstream commits/i })).toBeEnabled();
    await user.click(within(compare).getByRole('button', { name: /compare folders/i }));
    await waitFor(() => {
      expect(app.location().pathname).toBe(`${OVERVIEW}/folders`);
    });
    expect(app.search().get('leftBranch')).toBe('main');
    expect(app.search().get('rightBranch')).toBe('dev');
    expect(screen.getByRole('tab', { name: /app @ main ↔ app @ dev/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('uses the same choice for upstream analysis', async () => {
    const user = userEvent.setup();
    const app = renderApp(OVERVIEW);
    const compare = await screen.findByRole('region', { name: 'Compare' });
    for (const [side, branch] of [
      ['Base', 'main'],
      ['Target', 'dev'],
    ] as const) {
      await user.selectOptions(within(compare).getByLabelText(`${side} repository`), 'r1');
      await user.selectOptions(within(compare).getByLabelText(`${side} branch`), branch);
    }
    await user.click(within(compare).getByRole('button', { name: /check upstream commits/i }));
    await waitFor(() => {
      expect(app.location().pathname).toBe(`${OVERVIEW}/upstream`);
    });
    expect(app.search().get('leftBranch')).toBe('main');
  });

  it('does not list recent comparisons: new ones are opened from here, not reopened', async () => {
    renderApp(OVERVIEW);
    expect(await screen.findByRole('heading', { name: /compare two snapshots/i })).toBeVisible();
    expect(screen.queryByRole('list', { name: /recent comparisons/i })).not.toBeInTheDocument();
  });

  it('lists the session’s repos with their branches', async () => {
    renderApp(OVERVIEW);
    const list = await screen.findByRole('list', { name: /repositories/i });
    expect(within(list).getByText('app')).toBeInTheDocument();
    expect(within(list).getByText('https://github.com/acme/app.git')).toBeInTheDocument();
    expect(within(list).getByText(/2 branches/i)).toBeInTheDocument();
  });

  it('fetches the latest for a repo', async () => {
    const user = userEvent.setup();
    renderApp(OVERVIEW);
    await user.click(await screen.findByRole('button', { name: 'Fetch latest for app' }));
    expect(await screen.findByText(/3 branches/i)).toBeInTheDocument();
  });

  it('adds another repo on request', async () => {
    const user = userEvent.setup();
    renderApp(OVERVIEW);
    await screen.findByRole('list', { name: /repositories/i });
    expect(screen.queryByLabelText(/^repository url/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add another/i }));
    await user.type(screen.getByLabelText(/^repository url/i), 'https://github.com/acme/lib.git');
    await user.click(screen.getByRole('button', { name: /add repository/i }));
    await waitFor(() => {
      expect(added).toEqual(['https://github.com/acme/lib.git']);
    });
    expect(
      await within(screen.getByRole('list', { name: /repositories/i })).findByText('lib'),
    ).toBeInTheDocument();
  });
});
