import type { GitLog, GitLogRequest, GitLogCommit } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';
import { fileDiffHandlers } from '../test/file-diff-handlers.ts';

const L = '1'.repeat(40); // Left commit (pinned)
const R = '2'.repeat(40); // Right commit (pinned)
const C1 = 'a'.repeat(40); // Left-only, changed the file
const C2 = 'b'.repeat(40); // Left-only, changed something else (the newer of the two below)
const C3 = 'c'.repeat(40); // Left-only, earlier, a day before

const commit = (
  sha: string,
  subject: string,
  commitDate: string,
  over: Partial<GitLogCommit> = {},
): GitLogCommit => ({
  sha,
  subject,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: commitDate,
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate,
  parents: ['9'.repeat(40)],
  ...over,
});

const commits: GitLogCommit[] = [
  commit(C1, 'Change the file', '2026-01-02T10:00:00Z', { body: 'Why the file changed.' }),
  commit(C2, 'Change something else', '2026-01-02T09:00:00Z'),
  commit(C3, 'Earlier work', '2025-12-30T09:00:00Z', { parents: ['8'.repeat(40), '7'.repeat(40)] }),
];

let logRequests: GitLogRequest[];

beforeEach(() => {
  logRequests = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/log', async ({ request }) => {
      const body = (await request.json()) as GitLogRequest;
      logRequests.push(body);
      const page = body.paths ? commits.filter((c) => c.sha === C1) : commits;
      return HttpResponse.json<GitLog>({
        include: { commit: body.source.branch, ref: body.source.branch, label: 'app' },
        ...(body.exclude
          ? { exclude: { commit: body.exclude.branch, ref: body.exclude.branch, label: 'app' } }
          : {}),
        commits: page,
        hasMore: false,
        total: page.length,
      });
    }),
    ...fileDiffHandlers(() => ({
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
            { kind: 'added', text: 'new', rightLine: 1 },
          ],
        },
      ],
      commits: [{ ...commits[0]!, inLeft: true, inRight: false }],
    })),
  );
});

const url = (side: 'left' | 'right') =>
  `/u/karthik/s/s1/commits?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev` +
  `&leftCommit=${L}&rightCommit=${R}&leftPath=a.txt&rightPath=a.txt&side=${side}`;

const list = () => screen.findByRole('list', { name: 'Diverging commits' });

describe('Commit List tab', () => {
  it('lists the commits this side has and the other does not, grouped by day', async () => {
    renderApp(url('left'));
    const rows = await within(await list()).findAllByRole('button', { name: /Change|Earlier/ });
    expect(rows).toHaveLength(3);
    expect(screen.getByRole('heading', { name: '2 Jan 2026' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '30 Dec 2025' })).toBeInTheDocument();
    expect(logRequests.at(-1)).toMatchObject({ source: { branch: L }, exclude: { branch: R } });
  });

  it('touching the file: asks for the commits that changed the file only', async () => {
    const user = userEvent.setup();
    renderApp(url('left'));
    await list();
    await user.click(screen.getByRole('button', { name: 'Touching a.txt' }));
    await waitFor(() => {
      expect(logRequests.some((r) => r.paths?.[0] === 'a.txt')).toBe(true);
    });
    const rows = within(await list()).getAllByRole('button', { name: /Change|Earlier/ });
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Change the file')]);
  });

  it('accounting for the changes shown: lists the commits that account for the lines on screen', async () => {
    const user = userEvent.setup();
    renderApp(url('left'));
    await list();
    await user.click(screen.getByRole('button', { name: 'Accounting for the changes shown' }));
    const rows = await within(await list()).findAllByRole('button', { name: /Change|Earlier/ });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Change the file');
  });

  it('search filters the loaded commits by subject', async () => {
    const user = userEvent.setup();
    renderApp(url('left'));
    await list();
    await user.type(screen.getByRole('searchbox', { name: 'Search commits' }), 'something');
    const rows = within(await list()).getAllByRole('button', { name: /Change|Earlier/ });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Change something else'),
    ]);
  });

  it('selects two commits and opens the range between them, newer on top', async () => {
    const user = userEvent.setup();
    const app = renderApp(url('left'));
    await list();
    await user.click(screen.getByRole('button', { name: 'Select commits' }));
    await user.click(screen.getByRole('checkbox', { name: /Change something else/ }));
    await user.click(screen.getByRole('checkbox', { name: /Earlier work/ }));
    await user.click(screen.getByRole('button', { name: 'Log between these' }));
    await waitFor(() => {
      expect(app.location().pathname).toMatch(/\/log$/);
    });
    const params = new URLSearchParams(app.location().search);
    expect(params.get('top')).toBe(C2);
    expect(params.get('bottom')).toBe(C3);
  });

  it('opens a commit in its own tab from its row, and leaves the list where it is', async () => {
    const user = userEvent.setup();
    const app = renderApp(url('left'));
    const rows = await within(await list()).findAllByRole('button', {
      name: /Change something else/,
    });
    await user.click(rows[0]!);
    await waitFor(() => {
      expect(app.location().pathname).toMatch(/\/commit$/);
    });
    expect(new URLSearchParams(app.location().search).get('commit')).toBe(C2);
  });

  it('lists the Right side from the other direction', async () => {
    renderApp(url('right'));
    await list();
    expect(logRequests.at(-1)).toMatchObject({ source: { branch: R }, exclude: { branch: L } });
  });
});
