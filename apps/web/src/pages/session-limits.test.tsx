import type { SessionDetail } from '@om/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  USER,
  repoInfo,
  serverInfoHandler,
  sessionDetailHandler,
  sessionSummary,
} from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * The limits the server reports (GET /api/server) are shown as counts, and the actions they block
 * are disabled. The server still refuses past a limit; these tests cover what the user sees.
 */

const LIMITS = { sessionsPerUser: 2, reposPerSession: 2, remotesPerRepo: 10 };
const LIB = repoInfo({ id: 'r2', name: 'lib', url: 'https://github.com/acme/lib.git' });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('sessions at the limit', () => {
  it('shows the count and does not offer another session', async () => {
    server.use(
      serverInfoHandler({ limits: LIMITS }),
      http.get('*/api/users/:user/sessions', () =>
        HttpResponse.json([
          sessionSummary({ id: 's1', name: 'One' }),
          sessionSummary({ id: 's2', name: 'Two' }),
        ]),
      ),
    );
    renderApp(`/u/${USER}`);
    expect(await screen.findByText('Sessions 2 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText(/new session name/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /create session/i })).toBeDisabled();
    expect(screen.getByText(/delete one to start another/i)).toBeInTheDocument();
  });

  it('keeps the form open below the limit', async () => {
    server.use(
      serverInfoHandler({ limits: LIMITS }),
      http.get('*/api/users/:user/sessions', () =>
        HttpResponse.json([sessionSummary({ id: 's1', name: 'One' })]),
      ),
    );
    renderApp(`/u/${USER}`);
    expect(await screen.findByText('Sessions 1 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText(/new session name/i)).toBeEnabled();
  });
});

describe('repositories at the limit', () => {
  it('shows the count and does not offer another repository', async () => {
    server.use(
      serverInfoHandler({ limits: LIMITS }),
      sessionDetailHandler({ repos: [repoInfo(), LIB] }),
    );
    renderApp(`/u/${USER}/s/s1`);
    expect(await screen.findByText('Repositories 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add another/i })).toBeDisabled();
  });
});

describe('removing a repository', () => {
  it('asks first, then removes it from the session', async () => {
    let repos = [repoInfo(), LIB];
    const removed: string[] = [];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    server.use(
      serverInfoHandler({ limits: LIMITS }),
      http.get('*/api/users/:user/sessions/:sessionId', ({ params }) =>
        HttpResponse.json<SessionDetail>({
          user: USER,
          session: sessionSummary({ id: String(params['sessionId']) }),
          repos,
        }),
      ),
      http.delete('*/api/users/:user/sessions/:sessionId/repos/:repoId', ({ params }) => {
        removed.push(String(params['repoId']));
        repos = repos.filter((r) => r.id !== params['repoId']);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderApp(`/u/${USER}/s/s1`);
    await user.click(await screen.findByRole('button', { name: 'Remove app' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('app'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove app' })).not.toBeInTheDocument();
    });
    expect(removed).toEqual(['r1']);
    expect(screen.getByText('Repositories 1 of 2')).toBeInTheDocument();
  });

  it('removes nothing when the user does not confirm', async () => {
    const removed: string[] = [];
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    server.use(
      serverInfoHandler({ limits: LIMITS }),
      sessionDetailHandler({ repos: [repoInfo(), LIB] }),
      http.delete('*/api/users/:user/sessions/:sessionId/repos/:repoId', ({ params }) => {
        removed.push(String(params['repoId']));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderApp(`/u/${USER}/s/s1`);
    await user.click(await screen.findByRole('button', { name: 'Remove app' }));
    expect(removed).toEqual([]);
  });
});
