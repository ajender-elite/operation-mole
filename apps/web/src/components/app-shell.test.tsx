import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';
import { stubMatchMedia } from '../test/setup.ts';

beforeEach(() => {
  server.use(
    sessionDetailHandler(),
    http.get('*/api/users/:user/sessions', () => HttpResponse.json([])),
  );
});

describe('AppShell', () => {
  it('shows the OM brand with its mole logo', () => {
    renderApp('/');
    const brand = screen.getByRole('link', { name: /OM/ });
    expect(brand).toHaveAttribute('href', '/');
    expect(within(brand).getByRole('img', { name: /operation mole/i })).toBeInTheDocument();
  });

  it('shows the user, session and session pages inside a session', async () => {
    renderApp(`/u/${USER}/s/s1/upstream`);
    const context = screen.getByRole('navigation', { name: 'Context' });
    expect(within(context).getByRole('link', { name: USER })).toHaveAttribute('href', `/u/${USER}`);
    expect(await within(context).findByText('Release review')).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      `/u/${USER}/s/s1`,
    );
    expect(within(nav).getByRole('link', { name: 'Folders' })).toHaveAttribute(
      'href',
      `/u/${USER}/s/s1/folders`,
    );
    expect(within(nav).getByRole('link', { name: 'Files' })).toHaveAttribute(
      'href',
      `/u/${USER}/s/s1/files`,
    );
    expect(within(nav).getByRole('link', { name: 'Upstream' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('sends old Lab links to Upstream, keeping the query', async () => {
    const app = renderApp(`/u/${USER}/s/s1/lab?limit=50`);
    await waitFor(() => {
      expect(app.location().pathname).toBe(`/u/${USER}/s/s1/upstream`);
    });
    expect(app.search().get('limit')).toBe('50');
  });

  it('has no session navigation outside a session', () => {
    renderApp(`/u/${USER}`);
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('toggles between light and dark mode and remembers the choice', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(localStorage.getItem('om-theme')).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(localStorage.getItem('om-theme')).toBe('light');
  });

  it('starts from the system preference', () => {
    stubMatchMedia(true);
    renderApp('/');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument();
  });

  it('redirects old links to the start page', async () => {
    const app = renderApp('/directories?left=%2Fa&right=%2Fb');
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(app.location().pathname).toBe('/');
  });
});
