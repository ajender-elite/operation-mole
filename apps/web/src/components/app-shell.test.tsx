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

  it('shows the user and session inside a session, the session linking to its overview', async () => {
    renderApp(`/u/${USER}/s/s1/between?repo=r1&left=origin%2Fmain&right=origin%2Fdev`);
    const context = screen.getByRole('navigation', { name: 'Context' });
    expect(within(context).getByRole('link', { name: USER })).toHaveAttribute('href', `/u/${USER}`);
    // The session loads over the mocked API; allow for a busy machine (the suite runs in parallel).
    expect(
      await within(context).findByRole('link', { name: 'Release review' }, { timeout: 5000 }),
    ).toHaveAttribute('href', `/u/${USER}/s/s1`);
    // Working contexts are tabs inside the session, not a fixed menu of pages.
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /origin\/main … origin\/dev/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('sends old Lab links to the Overview, since they name no branches', async () => {
    const app = renderApp(`/u/${USER}/s/s1/lab?limit=50`);
    await waitFor(() => {
      expect(app.location().pathname).toBe(`/u/${USER}/s/s1`);
    });
  });

  it('has no session tabs outside a session', () => {
    renderApp(`/u/${USER}`);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('toggles between dark (default) and light mode and remembers the choice', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(localStorage.getItem('om-theme')).toBe('light');
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(localStorage.getItem('om-theme')).toBe('dark');
  });

  it('starts dark, even when the system prefers light', () => {
    stubMatchMedia(false);
    renderApp('/');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument();
  });

  it('redirects old links to the start page', async () => {
    const app = renderApp('/directories?left=%2Fa&right=%2Fb');
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(app.location().pathname).toBe('/');
  });
});
