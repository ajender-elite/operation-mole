import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const BASE = '/u/karthik/s/s1';

beforeEach(() => {
  server.use(sessionDetailHandler({ repos: [repoInfo({ name: 'app', defaultBranch: 'main' })] }));
});

describe('Overview: exploring a repository', () => {
  it('opens the default branch of a repo in its Code tab', async () => {
    const { router } = renderApp(BASE);
    await userEvent.click(await screen.findByRole('button', { name: 'Browse code' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/code`);
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('repo')).toBe('r1');
    expect(params.get('ref')).toBe('main');
  });

  it('opens the repo in the Branches tab', async () => {
    const { router } = renderApp(BASE);
    await userEvent.click(await screen.findByRole('button', { name: 'Branches' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/branches`);
    });
    expect(new URLSearchParams(router.state.location.search).get('repo')).toBe('r1');
  });

  it('offers nothing to explore before a repo is added', async () => {
    server.use(sessionDetailHandler({ repos: [] }));
    renderApp(BASE);
    expect(await screen.findByRole('heading', { name: 'Add a repository' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Explore' })).toBeNull();
  });
});
