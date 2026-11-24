import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

beforeEach(() => {
  server.use(sessionDetailHandler({ repos: [repoInfo({ id: 'r1', name: 'nginx' })] }));
});

describe('Overview: Commit log', () => {
  it('opens the serialized history from a top revision down to a bottom one', async () => {
    const user = userEvent.setup();
    const app = renderApp(`/u/${USER}/s/s1`);
    const section = await screen.findByRole('region', { name: 'Commit log' });
    await user.selectOptions(within(section).getByLabelText('Repository'), 'r1');
    await user.type(within(section).getByLabelText('Top (latest)'), 'stable-1.28');
    await user.type(within(section).getByLabelText('Bottom (older)'), 'stable-1.26');
    await user.click(within(section).getByRole('button', { name: 'Open commit log' }));
    await waitFor(() => {
      expect(app.location().pathname).toMatch(/\/log$/);
    });
    const params = new URLSearchParams(app.location().search);
    expect(params.get('repo')).toBe('r1');
    expect(params.get('top')).toBe('stable-1.28');
    expect(params.get('bottom')).toBe('stable-1.26');
  });

  it('keeps the button off until both revisions are given', async () => {
    const user = userEvent.setup();
    renderApp(`/u/${USER}/s/s1`);
    const section = await screen.findByRole('region', { name: 'Commit log' });
    await user.type(within(section).getByLabelText('Top (latest)'), 'main');
    expect(within(section).getByRole('button', { name: 'Open commit log' })).toBeDisabled();
  });
});
