import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { USER, serverInfoHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * The header's git chip: the git version, and what this server's git can reach. Names and flags
 * only: the panel never shows a URL, a credential or an environment value.
 */

const LIMITS = { sessionsPerUser: 10, reposPerSession: 10, remotesPerRepo: 10 };

describe('the git chip', () => {
  it('shows the git version and opens what the server can reach', async () => {
    server.use(
      serverInfoHandler({
        git: { version: '2.47.0.windows.2' },
        access: { protocols: ['https', 'ssh'], isInteractive: false, hasSshAgent: true },
        limits: LIMITS,
      }),
    );
    const user = userEvent.setup();
    renderApp(`/u/${USER}`);

    const chip = await screen.findByRole('button', { name: /git 2\.47\.0/i });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    await user.click(chip);

    const panel = await screen.findByRole('dialog', { name: /git on this server/i });
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByText('2.47.0.windows.2')).toBeInTheDocument();
    expect(within(panel).getByText('https, ssh')).toBeInTheDocument();
    expect(within(panel).getByText(/never asks for a password/i)).toBeInTheDocument();
    expect(within(panel).getByText(/ssh agent: available/i)).toBeInTheDocument();
    expect(within(panel).getByText(/10 sessions per user/i)).toBeInTheDocument();
  });

  it('says so when no SSH agent is set', async () => {
    server.use(serverInfoHandler({ limits: LIMITS }));
    const user = userEvent.setup();
    renderApp(`/u/${USER}`);
    await user.click(await screen.findByRole('button', { name: /git 2\.47/i }));
    const panel = await screen.findByRole('dialog', { name: /git on this server/i });
    expect(within(panel).getByText(/ssh agent: not set/i)).toBeInTheDocument();
  });
});
