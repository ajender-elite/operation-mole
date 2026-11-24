import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { savePicks } from '../lib/pick-tray.ts';
import { logCommit, logHandler } from '../test/explore-handlers.ts';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * The pick tray: commits added from the Commits tab go to the series, and the Series tab opens with the commits
 * collected in this browser tab when its URL names none.
 */

const BASE = '/u/karthik/s/s1';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PICK = '1'.repeat(40);

const trayKey = 'om-picks:karthik:s1:r1';

beforeEach(() => {
  sessionStorage.clear();
  server.use(sessionDetailHandler({ repos: [repoInfo()] }));
});

describe('Commits: adding commits to the series', () => {
  it('adds a commit to the series tray, and says it is in the series', async () => {
    server.use(
      logHandler([logCommit(SHA_A, 'Fix the folder'), logCommit(SHA_B, 'Add the folder')]),
    );
    renderApp(`${BASE}/commits?repo=r1&ref=main&path=src`);
    const add = await screen.findByRole('button', {
      name: `Add to the series: ${SHA_A.slice(0, 8)}`,
    });
    await userEvent.click(add);
    expect(JSON.parse(sessionStorage.getItem(trayKey) ?? '[]')).toEqual([SHA_A]);
    expect(
      await screen.findByRole('button', { name: `In the series: ${SHA_A.slice(0, 8)}` }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open the series (1)' })).toBeInTheDocument();
  });

  it('opens the Series tab with the picks collected so far', async () => {
    savePicks('karthik', 's1', 'r1', [SHA_B]);
    server.use(logHandler([logCommit(SHA_A, 'Fix the folder')]));
    const { router } = renderApp(`${BASE}/commits?repo=r1&ref=main`);
    await userEvent.click(await screen.findByRole('button', { name: 'Open the series (1)' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/series`);
    });
    expect(new URLSearchParams(router.state.location.search).get('picks')).toBe(SHA_B);
  });
});

describe('Series: the picks it opens with', () => {
  it('takes the commits collected in the tray when its URL names none', async () => {
    savePicks('karthik', 's1', 'r1', [PICK]);
    renderApp(`${BASE}/series?repo=r1`);
    expect(
      await screen.findByRole('button', { name: `Remove ${PICK.slice(0, 8)}` }),
    ).toBeInTheDocument();
  });

  it('keeps the tray in step when a pick is removed', async () => {
    savePicks('karthik', 's1', 'r1', [PICK, SHA_A]);
    renderApp(`${BASE}/series?repo=r1`);
    await userEvent.click(
      await screen.findByRole('button', { name: `Remove ${PICK.slice(0, 8)}` }),
    );
    expect(JSON.parse(sessionStorage.getItem(trayKey) ?? '[]')).toEqual([SHA_A]);
  });
});
