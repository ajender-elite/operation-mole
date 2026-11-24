import type { GitGrepMatch, GitGrepRequest } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { grepHandler, refEntry, refsHandler } from '../test/explore-handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * Two explorer tabs that read text and refs of one repo: Search (lines that match) and Branches (every branch and
 * tag of every remote). The Commits tab has its own tests (commits-page.test.tsx).
 */

const BASE = '/u/karthik/s/s1';

beforeEach(() => {
  server.use(sessionDetailHandler({ repos: [repoInfo()] }));
});

describe('Search tab', () => {
  const match = (path: string, line: number, text: string): GitGrepMatch => ({
    path,
    line,
    column: 1,
    text,
    // Line numbers start at 1, so the line before the first has no number.
    before: line > 1 ? [{ line: line - 1, text: 'before' }] : [],
    after: [],
  });

  it('searches the ref for the text typed, and groups the lines by file', async () => {
    const requests: unknown[] = [];
    server.use(
      grepHandler(
        [match('src/a.c', 2, 'return hello();'), match('src/http/b.c', 1, 'hello from b')],
        requests,
      ),
    );
    renderApp(`${BASE}/search?repo=r1&ref=main&q=hello`);
    expect(await screen.findByText('src/a.c', { selector: 'h2' })).toBeInTheDocument();
    // (The heading is a plain heading; the file's name is the only text in it.)
    expect(screen.getByText('src/http/b.c', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('2 matches in 2 files')).toBeInTheDocument();
    const request = requests[0] as GitGrepRequest;
    expect(request.query).toBe('hello');
    expect(request.ignoreCase).toBe(true);
    expect(request.regex).toBe(false);
  });

  it('sends the regular expression and match-case options it is given', async () => {
    const requests: unknown[] = [];
    server.use(grepHandler([], requests));
    renderApp(`${BASE}/search?repo=r1&ref=main&q=h.llo&regex=1&case=1&in=src`);
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toMatchObject({
      query: 'h.llo',
      regex: true,
      ignoreCase: false,
      paths: ['src'],
    });
  });

  it('opens a hit at its line in the Code tab', async () => {
    server.use(grepHandler([match('src/a.c', 2, 'return hello();')]));
    const { router } = renderApp(`${BASE}/search?repo=r1&ref=main&q=hello`);
    await userEvent.click(await screen.findByRole('button', { name: /return hello/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/code`);
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('path')).toBe('src/a.c');
    expect(params.get('lines')).toBe('2');
  });

  it('says when nothing matches', async () => {
    server.use(grepHandler([]));
    renderApp(`${BASE}/search?repo=r1&ref=main&q=nothing`);
    expect(await screen.findByText('Nothing in main matches “nothing”.')).toBeInTheDocument();
  });

  it('asks for nothing until there is a query', async () => {
    const requests: unknown[] = [];
    server.use(grepHandler([], requests));
    renderApp(`${BASE}/search?repo=r1&ref=main`);
    expect(await screen.findByText('Type a search to look through this ref.')).toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('Branches tab', () => {
  it('lists the branches and tags of each remote, grouped by remote, with ahead and behind', async () => {
    server.use(
      refsHandler([
        refEntry('origin', 'main', { ahead: 0, behind: 0 }),
        refEntry('origin', 'stable', { ahead: 0, behind: 2 }),
        refEntry('origin', 'v1', { kind: 'tag', subject: 'Release 1' }),
        refEntry('upstream', 'dev', { ahead: 1, behind: 0 }),
      ]),
    );
    const fetchedAt = '2026-11-21T10:00:00.000Z';
    server.use(
      sessionDetailHandler({
        repos: [
          repoInfo({
            remotes: [
              {
                name: 'origin',
                url: 'https://github.com/acme/app.git',
                defaultBranch: 'main',
                branches: ['main', 'stable'],
                fetchedAt,
              },
              {
                name: 'upstream',
                url: 'https://github.com/upstream/app.git',
                defaultBranch: 'main',
                branches: ['dev'],
                fetchedAt,
              },
            ],
          }),
        ],
      }),
    );
    renderApp(`${BASE}/branches?repo=r1`);
    const origin = await screen.findByRole('region', { name: 'Branches of origin' });
    expect(within(origin).getByText('stable')).toBeInTheDocument();
    expect(within(origin).getByText('↑0 ↓2')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Branches of upstream' })).toBeInTheDocument();
  });

  it('opens a branch in its Code tab, on the remote it is on', async () => {
    server.use(refsHandler([refEntry('upstream', 'dev')]));
    const { router } = renderApp(`${BASE}/branches?repo=r1`);
    const region = await screen.findByRole('region', { name: 'Branches of upstream' });
    await userEvent.click(within(region).getByRole('button', { name: 'Code' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/code`);
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('ref')).toBe('dev');
    expect(params.get('remote')).toBe('upstream');
  });

  it('compares a branch with the default branch, in a Between tab', async () => {
    server.use(refsHandler([refEntry('upstream', 'dev')]));
    const { router } = renderApp(`${BASE}/branches?repo=r1`);
    const region = await screen.findByRole('region', { name: 'Branches of upstream' });
    await userEvent.click(within(region).getByRole('button', { name: 'Compare with main' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/between`);
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('left')).toBe('upstream/dev');
    expect(params.get('right')).toBe('origin/main');
  });

  it('says so when the repo is not in the session', async () => {
    server.use(sessionDetailHandler({ repos: [] }));
    renderApp(`${BASE}/branches?repo=r1`);
    expect(
      await screen.findByText('This repository is no longer in the session.'),
    ).toBeInTheDocument();
  });
});

describe('Branches tab: filter', () => {
  it('shows only the branches and tags whose name matches the filter', async () => {
    server.use(
      refsHandler([
        refEntry('origin', 'main'),
        refEntry('origin', 'stable-1.28'),
        refEntry('upstream', 'dev'),
        refEntry('upstream', 'v1.0', { kind: 'tag' }),
      ]),
    );
    renderApp(`${BASE}/branches?repo=r1`);
    await screen.findByRole('region', { name: 'Branches of upstream' });
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Filter branches and tags' }),
      'STABLE',
    );
    expect(screen.getByText('stable-1.28')).toBeInTheDocument();
    expect(screen.queryByText('main')).toBeNull();
    expect(screen.queryByText('dev')).toBeNull();
    // A remote with nothing left to show is not listed at all.
    expect(screen.queryByRole('region', { name: 'Branches of upstream' })).toBeNull();
  });

  it('says so when nothing matches', async () => {
    server.use(refsHandler([refEntry('origin', 'main')]));
    renderApp(`${BASE}/branches?repo=r1`);
    await screen.findByRole('region', { name: 'Branches of origin' });
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Filter branches and tags' }),
      'zzz',
    );
    expect(screen.getByText('No branch or tag matches “zzz”.')).toBeInTheDocument();
  });
});
