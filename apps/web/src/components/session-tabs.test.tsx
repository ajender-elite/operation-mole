import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { tabIdentity } from '../lib/workspace.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';
import { stubViewport } from '../test/setup.ts';

const BASE = `/u/${USER}/s/s1`;
const FILE = `${BASE}/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev&leftCommit=${'1'.repeat(40)}&rightCommit=${'2'.repeat(40)}&leftPath=a.txt&rightPath=a.txt`;
const FOLDERS = `${BASE}/folders?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev`;
const UPSTREAM = `${BASE}/upstream?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev`;

/** The tab strip (not the page's own role=tab elements). */
const strip = () => screen.getByRole('tablist', { name: 'Open comparisons' });
const queryTab = (name: RegExp) => within(strip()).queryByRole('tab', { name });

/** Opens three tabs in this browser tab's session: overview, a file, a folder comparison, and upstream. */
function seedTabs(): void {
  sessionStorage.setItem(
    `om-tabs:${USER}:s1`,
    JSON.stringify([
      { id: tabIdentity(FILE, BASE), url: FILE },
      { id: tabIdentity(FOLDERS, BASE), url: FOLDERS },
      { id: tabIdentity(UPSTREAM, BASE), url: UPSTREAM },
    ]),
  );
}

beforeEach(() => {
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/upstream/commits', () =>
      HttpResponse.json({
        upstream: { commit: '1'.repeat(40), ref: 'main' },
        downstream: { commit: '2'.repeat(40), ref: 'dev' },
        upstreamLabel: 'app @ main',
        downstreamLabel: 'app @ dev',
        commits: [],
        hasMore: false,
      }),
    ),
  );
});

describe('workspace tab strip', () => {
  it('lists every open tab in the Tabs menu, and selects one from it', async () => {
    seedTabs();
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const user = userEvent.setup();
    renderApp(BASE);
    await user.click(await screen.findByRole('button', { name: /^tabs/i }));
    const menu = screen.getByRole('group', { name: 'Open tabs' });
    expect(within(menu).getAllByRole('button', { name: /^switch to/i })).toHaveLength(4);
    await user.click(within(menu).getByRole('button', { name: /switch to upstream/i }));
    expect(within(strip()).getByRole('tab', { name: /upstream/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('group', { name: 'Open tabs' })).not.toBeInTheDocument();
  });

  it('closes a tab from the Tabs menu, including a tab that is not selected', async () => {
    seedTabs();
    const user = userEvent.setup();
    renderApp(BASE);
    await user.click(await screen.findByRole('button', { name: /^tabs/i }));
    await user.click(
      within(screen.getByRole('group', { name: 'Open tabs' })).getByRole('button', {
        name: /close upstream/i,
      }),
    );
    await waitFor(() => {
      expect(queryTab(/upstream/i)).not.toBeInTheDocument();
    });
    expect(within(strip()).getByRole('tab', { name: /a\.txt/ })).toBeInTheDocument();
  });

  it('shows a fade on the right while tabs run off the edge', async () => {
    seedTabs();
    renderApp(BASE);
    const tablist = await screen.findByRole('tablist', { name: 'Open comparisons' });
    expect(tablist.parentElement?.querySelector('[data-fade="end"]')).toBeNull();
    Object.defineProperty(tablist, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: 360 });
    fireEvent.scroll(tablist);
    await waitFor(() => {
      expect(tablist.parentElement?.querySelector('[data-fade="end"]')).not.toBeNull();
    });
  });
});

describe('tab strip in landscape', () => {
  it('sits in the app header on a phone in landscape, so header and tabs take one row', async () => {
    seedTabs();
    stubViewport({ width: 844, height: 390, pointer: 'coarse' });
    renderApp(BASE);
    const header = await screen.findByRole('banner');
    expect(within(header).getByRole('tablist', { name: 'Open comparisons' })).toBeInTheDocument();
  });

  it('stays in the page on a desktop', async () => {
    seedTabs();
    stubViewport({ width: 1280, height: 800 });
    renderApp(BASE);
    await screen.findByRole('tablist', { name: 'Open comparisons' });
    expect(screen.getByRole('banner')).not.toContainElement(
      screen.getByRole('tablist', { name: 'Open comparisons' }),
    );
  });
});
