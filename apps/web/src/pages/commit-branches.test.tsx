import type { CommitPatch, GitCherryPick, GitLog } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPicks } from '../lib/pick-tray.ts';
import { commitInfo, refEntry, refsHandler } from '../test/explore-handlers.ts';
import { shortSha } from '../lib/attribution.ts';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * A commit's Branches pane: the commit checked as a one-pick series on every branch of every remote.
 * The Patch pane stays the default; the view is in the URL.
 */

const BASE = '/u/karthik/s/s1';
const SHA = 'd'.repeat(40);
const PARENT = 'e'.repeat(40);
const MATCH = 'f'.repeat(40);

/** Patch-equivalents of the branch against this commit: none, unless a test gives some. */
const noEquivalents = {
  left: { commit: 'a'.repeat(40), ref: 'x', label: 'x' },
  right: { commit: SHA, ref: SHA, label: 'x' },
  commits: [],
  truncated: false,
};

const patch: CommitPatch = {
  commit: SHA,
  details: { ...commitInfo(SHA, 'Tighten the parser'), parents: [PARENT] },
  baseParent: PARENT,
  truncated: false,
  files: [],
};

const verdict = (branch: string, status: 'applies' | 'in-history' | 'conflict'): GitCherryPick => ({
  onto: { commit: 'a'.repeat(40), ref: branch, label: `app @ ${branch}` },
  outcome: status === 'conflict' ? 'conflict' : 'applies',
  ...(status === 'conflict' ? { stoppedAt: 0 } : {}),
  issues: [],
  warnings: [],
  changedPaths: [],
  steps: [
    {
      index: 0,
      commit: { ...commitInfo(SHA, 'Tighten the parser'), parents: [PARENT] },
      status,
      files: ['src/parser.ts'],
      conflictedPaths: status === 'conflict' ? ['src/parser.ts'] : [],
      conflictedFiles: [],
      messages: [],
    },
  ],
});

beforeEach(() => {
  sessionStorage.clear();
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/show', () => HttpResponse.json(patch)),
    http.post('*/api/git/log', () =>
      HttpResponse.json<GitLog>({
        include: { commit: SHA, ref: SHA, label: 'app' },
        commits: [{ ...patch.details, body: '', files: [] }],
        hasMore: false,
        total: 1,
      }),
    ),
    http.post('*/api/git/patch-equivalents', () => HttpResponse.json(noEquivalents)),
    refsHandler([
      refEntry('origin', 'main'),
      refEntry('origin', 'stable'),
      refEntry('upstream', 'dev'),
      refEntry('origin', 'v1', { kind: 'tag' }),
    ]),
    http.post('*/api/git/cherry-pick', async ({ request }) => {
      const body = (await request.json()) as { onto: { remote: string; branch: string } };
      const key = `${body.onto.remote}/${body.onto.branch}`;
      if (key === 'origin/main') return HttpResponse.json(verdict('main', 'applies'));
      if (key === 'origin/stable') return HttpResponse.json(verdict('stable', 'in-history'));
      return HttpResponse.json(verdict('dev', 'conflict'));
    }),
  );
});

const url = `${BASE}/commit?repo=r1&commit=${SHA}`;

describe('Commit: the Branches pane', () => {
  it('keeps the patch as the default view', async () => {
    renderApp(url);
    expect(await screen.findByRole('button', { name: 'Patch' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('article', { name: /Check on/ })).toBeNull();
  });

  it('checks the commit on every branch of every remote, and gives each its verdict', async () => {
    renderApp(`${url}&pane=branches`);
    const main = await screen.findByRole('article', { name: 'Check on origin/main' });
    expect(await within(main).findByText('Would apply')).toBeInTheDocument();
    const stable = screen.getByRole('article', { name: 'Check on origin/stable' });
    expect(await within(stable).findByText('In history')).toBeInTheDocument();
    const dev = screen.getByRole('article', { name: 'Check on upstream/dev' });
    expect(await within(dev).findByText('Would conflict')).toBeInTheDocument();
    // Tags are not branches: the commit is not checked on v1.
    expect(screen.queryByRole('article', { name: 'Check on origin/v1' })).toBeNull();
  });

  it('switches to the branches view and back, keeping the commit', async () => {
    const { router } = renderApp(url);
    await userEvent.click(await screen.findByRole('button', { name: 'Branches' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('pane')).toBe('branches');
    });
    expect(new URLSearchParams(router.state.location.search).get('commit')).toBe(SHA);
    await userEvent.click(screen.getByRole('button', { name: 'Patch' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('pane')).toBeNull();
    });
  });

  it('adds the commit to the series from the header, once', async () => {
    renderApp(url);
    await userEvent.click(await screen.findByRole('button', { name: 'Add to series' }));
    expect(loadPicks('karthik', 's1', 'r1')).toEqual([SHA]);
    expect(await screen.findByRole('button', { name: 'In series' })).toBeDisabled();
  });

  it('says so when the repo has no branches to check on', async () => {
    server.use(refsHandler([refEntry('origin', 'v1', { kind: 'tag' })]));
    renderApp(`${url}&pane=branches`);
    expect(
      await screen.findByText('No branches to check on. Fetch the repo first.'),
    ).toBeInTheDocument();
  });
});

describe('Commit: the Branches pane, picked as another commit', () => {
  it('says the change is already on a branch as another commit, found by its patch', async () => {
    server.use(
      http.post('*/api/git/patch-equivalents', async ({ request }) => {
        const body = (await request.json()) as { left: { branch: string } };
        if (body.left.branch !== 'main') return HttpResponse.json(noEquivalents);
        return HttpResponse.json({
          ...noEquivalents,
          commits: [
            {
              commit: { ...commitInfo(SHA, 'Tighten the parser'), parents: [PARENT] },
              mark: 'equivalent',
            },
            {
              commit: { ...commitInfo(MATCH, 'Tighten the parser, again'), parents: [] },
              mark: 'equivalent',
            },
          ],
        });
      }),
    );
    renderApp(`${url}&pane=branches`);
    const main = await screen.findByRole('article', { name: 'Check on origin/main' });
    expect(await within(main).findByText(/Picked as/)).toBeInTheDocument();
    expect(within(main).getByText(shortSha(MATCH))).toBeInTheDocument();
    expect(within(main).getByText('Would apply')).toBeInTheDocument();
    const stable = screen.getByRole('article', { name: 'Check on origin/stable' });
    await within(stable).findByText('In history');
    expect(within(stable).queryByText(/Picked as/)).toBeNull();
  });
});

describe('Commit: the Branches pane, picked by a message', () => {
  it('says the branch noted the pick in its message, when the patch is not the same', async () => {
    server.use(
      http.post('*/api/git/patch-equivalents', () => HttpResponse.json(noEquivalents)),
      http.post('*/api/git/log', async ({ request }) => {
        const body = (await request.json()) as { source: { branch: string } };
        if (body.source.branch !== 'main') {
          return HttpResponse.json<GitLog>({
            include: { commit: SHA, ref: body.source.branch, label: 'x' },
            commits: [],
            hasMore: false,
            total: 0,
          });
        }
        return HttpResponse.json<GitLog>({
          include: { commit: 'a'.repeat(40), ref: 'main', label: 'app @ main' },
          commits: [
            {
              ...commitInfo(MATCH, 'Backport the fix'),
              parents: [],
              body: `Backport the fix\n\n(cherry picked from commit ${SHA})`,
              files: [],
            },
          ],
          hasMore: false,
          total: 1,
        });
      }),
    );
    renderApp(`${url}&pane=branches`);
    const main = await screen.findByRole('article', { name: 'Check on origin/main' });
    expect(
      await within(main).findByText(
        /the branch says it picked this commit \(noted in its message\)/,
      ),
    ).toBeInTheDocument();
  });
});
