import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const FOLDERS = `/u/${USER}/s/s1/folders`;

beforeEach(() => {
  server.use(sessionDetailHandler({ repos: [repoInfo()] }));
});

describe('keyboard shortcuts dialog', () => {
  it('opens with ? and lists every shortcut with what it does and where', async () => {
    renderApp(FOLDERS);
    await userEvent.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Go to a file by name')).toBeInTheDocument();
    expect(within(dialog).getByText('Next or previous commit')).toBeInTheDocument();
    expect(within(dialog).getByText('Commits')).toBeInTheDocument();
  });

  it('closes with Escape', async () => {
    renderApp(FOLDERS);
    await userEvent.keyboard('?');
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });
});
