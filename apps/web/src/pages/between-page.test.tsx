import type { GitPatchEquivalents } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPicks } from '../lib/pick-tray.ts';
import { commitInfo, refEntry, refsHandler } from '../test/explore-handlers.ts';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * Between: the commits on each side of two branches, marked as on one side or picked across.
 */

const BASE = '/u/karthik/s/s1';
const ONLY_LEFT = '1'.repeat(40);
const ONLY_RIGHT = '2'.repeat(40);
const ACROSS = '3'.repeat(40);

const parents = ['9'.repeat(40)];
const compare: GitPatchEquivalents = {
  left: { commit: 'a'.repeat(40), ref: 'dev', label: 'app @ dev' },
  right: { commit: 'b'.repeat(40), ref: 'main', label: 'app @ main' },
  commits: [
    { commit: { ...commitInfo(ONLY_LEFT, 'Fix on dev'), parents }, mark: 'left' },
    { commit: { ...commitInfo(ONLY_RIGHT, 'Only on main'), parents }, mark: 'right' },
    { commit: { ...commitInfo(ACROSS, 'Same fix'), parents }, mark: 'equivalent' },
  ],
};

beforeEach(() => {
  sessionStorage.clear();
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    refsHandler([refEntry('upstream', 'dev'), refEntry('origin', 'main')]),
    http.post('*/api/git/patch-equivalents', () => HttpResponse.json(compare)),
  );
});

const url = `${BASE}/between?repo=r1&left=upstream/dev&right=origin/main`;

describe('Between tab', () => {
  it('marks each commit as on one side, or picked across', async () => {
    renderApp(url);
    const list = await screen.findByRole('list', { name: /Commits in/ });
    expect(within(list).getByText('Only on the left')).toBeInTheDocument();
    expect(within(list).getByText('Only on the right')).toBeInTheDocument();
    expect(within(list).getByText('Picked across')).toBeInTheDocument();
    expect(within(list).getByText('Fix on dev')).toBeInTheDocument();
  });

  it('filters to one mark', async () => {
    renderApp(url);
    await screen.findByRole('list', { name: /Commits in/ });
    await userEvent.click(screen.getByRole('button', { name: /^Only on the left · 1$/ }));
    const list = screen.getByRole('list', { name: /Commits in/ });
    expect(within(list).getByText('Fix on dev')).toBeInTheDocument();
    expect(within(list).queryByText('Only on the right')).toBeNull();
  });

  it('adds every commit only on the left to the series, in one step', async () => {
    renderApp(url);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add all only on the left to the series' }),
    );
    await waitFor(() => {
      expect(loadPicks('karthik', 's1', 'r1')).toEqual([ONLY_LEFT]);
    });
    expect(
      await screen.findByRole('button', { name: `In the series: ${ONLY_LEFT.slice(0, 8)}` }),
    ).toBeDisabled();
  });

  it('adds one commit to the series from its row', async () => {
    renderApp(url);
    await userEvent.click(
      await screen.findByRole('button', { name: `Add to the series: ${ACROSS.slice(0, 8)}` }),
    );
    await waitFor(() => {
      expect(loadPicks('karthik', 's1', 'r1')).toEqual([ACROSS]);
    });
  });

  it('says so when the two branches hold the same commits', async () => {
    server.use(
      http.post('*/api/git/patch-equivalents', () =>
        HttpResponse.json({ ...compare, commits: [] }),
      ),
    );
    renderApp(url);
    expect(
      await screen.findByText('Nothing to compare: dev and main hold the same commits.'),
    ).toBeInTheDocument();
  });

  it('explains an incomplete link', async () => {
    renderApp(`${BASE}/between?repo=r1`);
    expect(await screen.findByText(/This comparison link is incomplete/)).toBeInTheDocument();
  });
});
