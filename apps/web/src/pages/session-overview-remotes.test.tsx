import type { RemoteInfo, RepoInfo } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repoInfo, USER, serverInfoHandler, sessionSummary } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * The remotes of each repo in the overview: listing them with their own branches, adding one,
 * fetching one, removing one, and the per-repo limit.
 */

const FORK: RemoteInfo = {
  name: 'fork',
  url: 'https://github.com/fork/app.git',
  defaultBranch: 'main',
  branches: ['dev', 'main'],
  fetchedAt: '2026-11-22T10:00:00.000Z',
};

let repos: RepoInfo[];
let posted: Array<{ name: string; url: string }>;
let fetched: string[];
let removed: string[];
let refusal: { status: number; message: string } | undefined;

const ORIGIN_URL = 'https://github.com/acme/app.git';

beforeEach(() => {
  posted = [];
  fetched = [];
  removed = [];
  refusal = undefined;
  repos = [repoInfo()];
  server.use(
    http.get('*/api/users/:user/sessions/:sessionId', () =>
      HttpResponse.json({ user: USER, session: sessionSummary(), repos, recent: [] }),
    ),
    http.post(
      '*/api/users/:user/sessions/:sessionId/repos/:repoId/remotes',
      async ({ request, params }) => {
        const body = (await request.json()) as { name: string; url: string };
        posted.push(body);
        if (refusal) {
          return HttpResponse.json({ message: refusal.message }, { status: refusal.status });
        }
        repos = repos.map((r) =>
          r.id === params['repoId']
            ? { ...r, remotes: [...r.remotes, { ...FORK, name: body.name, url: body.url }] }
            : r,
        );
        return HttpResponse.json(repos[0], { status: 201 });
      },
    ),
    http.post(
      '*/api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote/fetch',
      ({ params }) => {
        fetched.push(String(params['remote']));
        return HttpResponse.json(repos[0]);
      },
    ),
    http.delete(
      '*/api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote',
      ({ params }) => {
        const name = String(params['remote']);
        removed.push(name);
        repos = repos.map((r) => ({ ...r, remotes: r.remotes.filter((x) => x.name !== name) }));
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const OVERVIEW = `/u/${USER}/s/s1`;

const ORIGIN: RemoteInfo = {
  name: 'origin',
  url: ORIGIN_URL,
  defaultBranch: 'main',
  branches: ['dev', 'main'],
  fetchedAt: '2026-11-21T10:00:00.000Z',
};

/** The app repo with its origin and a fork. */
const withFork = (): RepoInfo[] => [repoInfo({ remotes: [ORIGIN, FORK] })];

describe('remotes of a repository', () => {
  it('lists each remote with its own branches', async () => {
    repos = withFork();
    renderApp(OVERVIEW);
    const list = await screen.findByRole('list', { name: 'Remotes of app' });
    expect(within(list).getByText('origin')).toBeInTheDocument();
    expect(within(list).getByText('fork')).toBeInTheDocument();
    expect(within(list).getByText('https://github.com/fork/app.git')).toBeInTheDocument();
    expect(within(list).getByText(ORIGIN_URL)).toBeInTheDocument();
  });

  it('adds a remote under the name and URL given', async () => {
    const user = userEvent.setup();
    renderApp(OVERVIEW);
    await user.click(await screen.findByRole('button', { name: 'Add remote to app' }));
    await user.type(screen.getByLabelText(/^remote name/i), 'mirror');
    await user.type(screen.getByLabelText(/^remote url/i), 'https://example.com/mirror.git');
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    await waitFor(() => {
      expect(posted).toEqual([{ name: 'mirror', url: 'https://example.com/mirror.git' }]);
    });
    expect(
      await within(screen.getByRole('list', { name: 'Remotes of app' })).findByText('mirror'),
    ).toBeInTheDocument();
  });

  it('shows the server’s refusal when the name is already used', async () => {
    refusal = { status: 409, message: 'This repository already has a remote named "origin"' };
    const user = userEvent.setup();
    renderApp(OVERVIEW);
    await user.click(await screen.findByRole('button', { name: 'Add remote to app' }));
    await user.type(screen.getByLabelText(/^remote name/i), 'origin');
    await user.type(screen.getByLabelText(/^remote url/i), 'https://example.com/other.git');
    await user.click(screen.getByRole('button', { name: 'Add remote' }));
    expect(await screen.findByText(/already has a remote named "origin"/)).toBeInTheDocument();
  });

  it('fetches one remote, not the others', async () => {
    repos = withFork();
    const user = userEvent.setup();
    renderApp(OVERVIEW);
    await user.click(await screen.findByRole('button', { name: 'Fetch fork for app' }));
    await waitFor(() => {
      expect(fetched).toEqual(['fork']);
    });
  });

  it('removes a remote after a confirm, and keeps the repo', async () => {
    repos = withFork();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderApp(OVERVIEW);
    await user.click(await screen.findByRole('button', { name: 'Remove remote fork from app' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => {
      expect(removed).toEqual(['fork']);
    });
    const list = screen.getByRole('list', { name: 'Remotes of app' });
    await waitFor(() => {
      expect(within(list).queryByText('fork')).not.toBeInTheDocument();
    });
    expect(within(list).getByText('origin')).toBeInTheDocument();
  });

  it('offers no remove on a repo’s only remote', async () => {
    renderApp(OVERVIEW);
    await screen.findByRole('list', { name: 'Remotes of app' });
    expect(
      screen.queryByRole('button', { name: 'Remove remote origin from app' }),
    ).not.toBeInTheDocument();
  });

  it('checks whether a remote answers, and shows git’s reason when it does not', async () => {
    repos = withFork();
    server.use(
      http.post(
        '*/api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote/check',
        ({ params }) =>
          params['remote'] === 'fork'
            ? HttpResponse.json({ reachable: false, message: 'Repository not found.' })
            : HttpResponse.json({ reachable: true, message: '' }),
      ),
    );
    const user = userEvent.setup();
    renderApp(OVERVIEW);
    const list = await screen.findByRole('list', { name: 'Remotes of app' });
    await user.click(within(list).getByRole('button', { name: 'Check access to origin for app' }));
    expect(await within(list).findByText('Reachable')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Check access to fork for app' }));
    expect(await within(list).findByText('Repository not found.')).toBeInTheDocument();
  });

  it('disables adding a remote at the per-repo limit', async () => {
    repos = withFork();
    server.use(
      serverInfoHandler({
        limits: { sessionsPerUser: 10, reposPerSession: 10, remotesPerRepo: 2 },
      }),
    );
    renderApp(OVERVIEW);
    expect(await screen.findByRole('button', { name: 'Add remote to app' })).toBeDisabled();
  });
});
