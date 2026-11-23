import type { UpstreamCommitList } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const L = '1'.repeat(40); // Base commit (pinned)
const R = '2'.repeat(40); // Target commit (pinned)
const C1 = 'a'.repeat(40); // Base-only commit that changed the file
const C2 = 'b'.repeat(40); // Base-only commit that changed something else
const C3 = 'c'.repeat(40); // Target-only commit (not in this list)

const info = (sha: string, subject: string) => ({
  sha,
  subject,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-02T00:00:00Z',
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate: '2026-01-02T00:00:00Z',
});

const listOf = (commits: Array<ReturnType<typeof info>>): UpstreamCommitList => ({
  upstream: { commit: L, ref: 'main' },
  downstream: { commit: R, ref: 'dev' },
  upstreamLabel: 'app @ main',
  downstreamLabel: 'app @ dev',
  commits: commits.map((c) => ({ ...c, parents: [], reachableFromDownstream: false })),
  hasMore: false,
});

let listRequests: Array<{ paths?: string[] }>;

beforeEach(() => {
  listRequests = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/upstream/commits', async ({ request }) => {
      const body = (await request.json()) as { paths?: string[] };
      listRequests.push(body);
      // The server answers the file-scoped question with only the commits that touched it.
      return HttpResponse.json(
        listOf(
          body.paths
            ? [info(C1, 'Change the file')]
            : [info(C1, 'Change the file'), info(C2, 'Change something else')],
        ),
      );
    }),
    http.post('*/api/snapshot/file-diff', () =>
      HttpResponse.json({
        leftCommit: L,
        rightCommit: R,
        leftPath: 'a.txt',
        rightPath: 'a.txt',
        content: 'text',
        hunks: [
          {
            header: '@@ -1 +1 @@',
            leftStart: 1,
            leftCount: 1,
            rightStart: 1,
            rightCount: 1,
            lines: [
              { kind: 'removed', text: 'old', leftLine: 1, commit: C1 },
              { kind: 'added', text: 'new', rightLine: 1, commit: C3 },
            ],
          },
        ],
        commits: [
          { ...info(C1, 'Change the file'), inLeft: true, inRight: false },
          { ...info(C3, 'Target change'), inLeft: false, inRight: true },
        ],
      }),
    ),
  );
});

const url = (side: 'left' | 'right') =>
  `/u/karthik/s/s1/commits?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev` +
  `&leftCommit=${L}&rightCommit=${R}&leftPath=a.txt&rightPath=a.txt&side=${side}`;

describe('Commit List tab', () => {
  it('separates the commits that account for the changes, that touch the file, and all diverging commits', async () => {
    renderApp(url('left'));

    const visible = await screen.findByRole('region', { name: 'Accounting for the changes shown' });
    expect(await within(visible).findByRole('button', { name: /Change the file/ })).toBeVisible();
    expect(within(visible).queryByText('Target change')).not.toBeInTheDocument();

    const touching = screen.getByRole('region', { name: 'Touching a.txt' });
    expect(await within(touching).findByRole('button', { name: /Change the file/ })).toBeVisible();
    expect(within(touching).queryByText('Change something else')).not.toBeInTheDocument();

    const all = screen.getByRole('region', { name: 'All diverging commits on Base' });
    expect(await within(all).findByRole('button', { name: /Change something else/ })).toBeVisible();
  });

  it('asks the server for the commits of this file only when a file is pinned', async () => {
    renderApp(url('left'));
    await screen.findByRole('region', { name: 'Touching a.txt' });
    await waitFor(() => {
      expect(listRequests.some((r) => r.paths?.[0] === 'a.txt')).toBe(true);
    });
    expect(listRequests.some((r) => r.paths === undefined)).toBe(true);
  });

  it('opens a commit in a new tab and leaves the list where it is', async () => {
    const { location } = renderApp(url('left'));
    const user = userEvent.setup();
    const all = await screen.findByRole('region', { name: 'All diverging commits on Base' });
    await user.click(await within(all).findByRole('button', { name: /Change something else/ }));

    await waitFor(() => {
      expect(location().pathname).toMatch(/\/commit$/);
    });
    expect(new URLSearchParams(location().search).get('commit')).toBe(C2);
    expect(new URLSearchParams(location().search).get('repo')).toBe('r1');
  });

  it('lists the Target side from the other direction', async () => {
    renderApp(url('right'));
    expect(
      await screen.findByRole('region', { name: 'All diverging commits on Target' }),
    ).toBeVisible();
  });
});
