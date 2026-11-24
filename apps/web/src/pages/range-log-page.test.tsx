import type { CommitPatch, GitLog, GitLogCommit, GitShowRequest, GitLogRequest } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const TOP = 'a'.repeat(40);
const BOTTOM = 'b'.repeat(40);
const sha = (n: number) => String(n).repeat(40);

/** Five commits between BOTTOM (excluded) and TOP, newest first. */
const history: GitLogCommit[] = [1, 2, 3, 4, 5].map((n) => ({
  sha: sha(n),
  subject: `Change ${n}`,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-02T10:00:00Z',
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate: '2026-01-02T10:00:00Z',
  parents: [sha(n + 1)],
  body: `Details of change ${n}`,
  files: [{ path: `file${n}.txt`, additions: n, deletions: 0, binary: false }],
}));

let logRequests: GitLogRequest[];
let showRequests: GitShowRequest[];
let isExcludeAncestor = true;

const patch = (commit: string): CommitPatch => ({
  commit,
  details: {
    sha: commit,
    subject: 'Change',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2026-01-02T10:00:00Z',
    committerName: 'Ada',
    committerEmail: 'ada@example.com',
    commitDate: '2026-01-02T10:00:00Z',
    parents: [],
  },
  files: [
    {
      newPath: 'changed.txt',
      status: 'modified',
      binary: false,
      hunks: [
        {
          header: '@@ -1 +1 @@',
          leftStart: 1,
          leftCount: 1,
          rightStart: 1,
          rightCount: 1,
          lines: [
            { kind: 'removed', text: 'old', leftLine: 1 },
            { kind: 'added', text: 'new', rightLine: 1 },
          ],
        },
      ],
    },
  ],
  truncated: false,
});

beforeEach(() => {
  logRequests = [];
  showRequests = [];
  isExcludeAncestor = true;
  server.use(
    sessionDetailHandler({ repos: [repoInfo({ branches: ['main', 'dev'] })] }),
    http.post('*/api/git/log', async ({ request }) => {
      const body = (await request.json()) as GitLogRequest;
      logRequests.push(body);
      if (body.exclude === undefined) {
        // The bottom commit's own details (the end of the range).
        return HttpResponse.json<GitLog>({
          include: { commit: BOTTOM, ref: 'dev', label: 'app @ dev' },
          commits: [
            { ...history[0]!, sha: BOTTOM, subject: 'Left of the range', files: undefined },
          ],
          hasMore: false,
          total: 1,
        });
      }
      const skip = body.skip ?? 0;
      const limit = body.limit ?? 50;
      // Pages of two, so the test can reach the next page.
      const size = Math.min(limit, 2);
      const page = history.slice(skip, skip + size);
      return HttpResponse.json<GitLog>({
        include: { commit: TOP, ref: 'main', label: 'app @ main' },
        exclude: { commit: BOTTOM, ref: 'dev', label: 'app @ dev' },
        commits: page,
        hasMore: skip + size < history.length,
        total: history.length,
        excludeIsAncestor: isExcludeAncestor,
      });
    }),
    http.post('*/api/git/show', async ({ request }) => {
      const body = (await request.json()) as GitShowRequest;
      showRequests.push(body);
      return HttpResponse.json(patch(body.source.branch));
    }),
  );
});

const url = (top = TOP, bottom = BOTTOM) =>
  `/u/${USER}/s/s1/log?repo=r1&top=${top}&bottom=${bottom}`;

describe('Range Log tab', () => {
  it('lists the commits from the top down, newest first, and ends with the bottom commit', async () => {
    renderApp(url());
    const list = await screen.findByRole('list', { name: 'Commits in the range' });
    const subjects = within(list)
      .getAllByRole('listitem', { name: /^Change/ })
      .map((li) => li.getAttribute('aria-label') ?? '');
    // The first page holds two commits (the mock's page size); the rest load on request.
    expect(subjects).toEqual(['Change 1', 'Change 2']);
    expect(screen.getByText(/5 commits/)).toBeInTheDocument();
    const end = screen.getByRole('listitem', { name: 'End of range' });
    expect(end).toHaveTextContent('Left of the range');
  });

  it('warns when the bottom commit is not in the history of the top one', async () => {
    isExcludeAncestor = false;
    renderApp(url());
    expect(
      await screen.findByText(/is not in .* history; showing commits in .* that are not in/i),
    ).toBeInTheDocument();
  });

  it('loads the next page of commits on request', async () => {
    const user = userEvent.setup();
    renderApp(url());
    await screen.findByRole('listitem', { name: 'Change 2' });
    expect(screen.queryByRole('listitem', { name: 'Change 3' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more commits' }));
    expect(await screen.findByRole('listitem', { name: 'Change 3' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Change 2' })).toBeInTheDocument();
  });

  it('asks for stats and bodies, and pages by skip', async () => {
    renderApp(url());
    await screen.findByRole('list', { name: 'Commits in the range' });
    expect(logRequests.some((r) => r.withStats === true && r.withBody === true)).toBe(true);
    expect(logRequests.some((r) => r.source.branch === TOP && r.exclude?.branch === BOTTOM)).toBe(
      true,
    );
  });

  it("shows a commit's changes inline when it is expanded, and fetches them once", async () => {
    const user = userEvent.setup();
    renderApp(url());
    const first = await screen.findByRole('listitem', { name: /Change 1/ });
    await user.click(within(first).getByRole('button', { name: 'Show changes' }));
    expect(await within(first).findByText('changed.txt')).toBeInTheDocument();
    expect(showRequests.map((r) => r.source.branch)).toEqual([sha(1)]);
  });

  it('asks for a link to the range when the page has no top or bottom', () => {
    renderApp(`/u/${USER}/s/s1/log?repo=r1&top=${TOP}`);
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete/i);
  });

  it('keeps the existing attribution-free Commit tab reachable from each entry', async () => {
    const user = userEvent.setup();
    const app = renderApp(url());
    const first = await screen.findByRole('listitem', { name: /Change 1/ });
    await user.click(within(first).getByRole('button', { name: 'Open commit' }));
    await waitFor(() => {
      expect(app.location().pathname).toMatch(/\/commit$/);
    });
  });
});
