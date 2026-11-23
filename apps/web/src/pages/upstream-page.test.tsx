import type {
  ApplicabilityRequest,
  ApplicabilityResult,
  CommitPatch,
  UpstreamCommit,
  UpstreamCommitList,
  UpstreamCommitsRequest,
} from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER, repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const UP_TIP = 'a'.repeat(40);
const DOWN_TIP = 'd'.repeat(40);
const sha = (n: number) => String(n).repeat(40);

const commit = (
  n: number,
  subject: string,
  over: Partial<UpstreamCommit> = {},
): UpstreamCommit => ({
  sha: sha(n),
  subject,
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  authorDate: '2026-01-01T10:00:00Z',
  committerName: 'Alice',
  committerEmail: 'alice@example.com',
  commitDate: '2026-01-02T10:00:00Z',
  parents: [sha(n + 1)],
  reachableFromDownstream: false,
  ...over,
});

const commits = [
  commit(1, 'Add feature'),
  commit(2, 'Change shared line'),
  commit(3, 'Add util'),
  commit(4, 'Early work', { reachableFromDownstream: true }),
];

const base = (n: number): ApplicabilityResult => ({
  commit: sha(n),
  downstreamCommit: DOWN_TIP,
  status: 'clean',
  reason: 'applies',
  baseParent: sha(n + 1),
  isMerge: false,
  files: [],
  equivalentCommits: [],
  conflicts: [],
  messages: [],
});

const results: Record<string, ApplicabilityResult> = {
  [sha(1)]: {
    ...base(1),
    files: [
      { path: 'feature.txt', outcome: 'applies' },
      { path: 'p1.txt', outcome: 'already-present' },
    ],
  },
  [sha(2)]: {
    ...base(2),
    status: 'conflict',
    reason: 'conflict',
    files: [{ path: 'shared.txt', outcome: 'conflict' }],
    conflicts: [
      {
        path: 'shared.txt',
        startLine: 1,
        lines: ['1', `<<<<<<< ${DOWN_TIP}`, '2-down', '=======', '2-up', `>>>>>>> ${sha(2)}`],
      },
    ],
    messages: ['Auto-merging shared.txt', 'CONFLICT (content): Merge conflict in shared.txt'],
  },
  [sha(3)]: {
    ...base(3),
    status: 'represented',
    reason: 'equivalent-patch',
    files: [{ path: 'util.txt', outcome: 'already-present' }],
    equivalentCommits: [{ ...commit(9, 'Add util (cherry-picked)'), committerName: 'Bob' }],
  },
  [sha(4)]: { ...base(4), status: 'represented', reason: 'reachable' },
};

let listRequests: UpstreamCommitsRequest[];
let applyRequests: ApplicabilityRequest[];

beforeEach(() => {
  listRequests = [];
  applyRequests = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo({ branches: ['main', 'product'] })] }),
    http.post('*/api/upstream/commits', async ({ request }) => {
      const body = (await request.json()) as UpstreamCommitsRequest;
      listRequests.push(body);
      const list: UpstreamCommitList = {
        upstream: { commit: UP_TIP, ref: 'main' },
        downstream: { commit: DOWN_TIP, ref: 'product' },
        upstreamLabel: 'app @ main',
        downstreamLabel: 'app @ product',
        commits:
          body.hideReachable === true ? commits.filter((c) => !c.reachableFromDownstream) : commits,
        hasMore: false,
      };
      return HttpResponse.json(list);
    }),
    http.post('*/api/upstream/applicability', async ({ request }) => {
      const body = (await request.json()) as ApplicabilityRequest;
      applyRequests.push(body);
      return HttpResponse.json(results[body.commit]);
    }),
    http.post('*/api/upstream/patch', () =>
      HttpResponse.json<CommitPatch>({
        commit: sha(2),
        baseParent: sha(3),
        truncated: false,
        files: [
          {
            oldPath: 'shared.txt',
            newPath: 'shared.txt',
            status: 'modified',
            binary: false,
            hunks: [
              {
                header: '@@ -2 +2 @@',
                leftStart: 2,
                leftCount: 1,
                rightStart: 2,
                rightCount: 1,
                lines: [
                  { kind: 'removed', text: '2', leftLine: 2 },
                  { kind: 'added', text: '2-up', rightLine: 2 },
                ],
              },
            ],
          },
        ],
      }),
    ),
  );
});

const PAGE = `/u/${USER}/s/s1/upstream?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=product`;
const summary = () => screen.getByRole('group', { name: /applicability summary/i });

describe('UpstreamPage', () => {
  it('asks for upstream and downstream git snapshots', async () => {
    renderApp(`/u/${USER}/s/s1/upstream`);
    expect(await screen.findByText(/choose the upstream branch/i)).toBeInTheDocument();
    expect(await screen.findByLabelText('Upstream repository')).toBeInTheDocument();
    expect(screen.getByLabelText('Downstream repository')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /folder/i })).not.toBeInTheDocument();
  });

  it('evaluates every commit independently against the same pinned downstream', async () => {
    renderApp(PAGE);
    expect(await screen.findByRole('list', { name: 'Upstream commits' })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(summary()).getByRole('button', { name: /clean apply.*1/i }),
      ).toBeInTheDocument();
    });
    expect(
      within(summary()).getByRole('button', { name: /already represented.*2/i }),
    ).toBeInTheDocument();
    expect(
      within(summary()).getByRole('button', { name: /conflicting apply.*1/i }),
    ).toBeInTheDocument();
    expect(listRequests[0]).toMatchObject({ limit: 20, hideReachable: false, firstParent: false });
    expect(applyRequests.map((r) => r.commit).sort()).toEqual([sha(1), sha(2), sha(3), sha(4)]);
    // Every evaluation targets the exact downstream commit the window was computed for.
    expect(new Set(applyRequests.map((r) => r.downstream.branch))).toEqual(new Set([DOWN_TIP]));
    expect(new Set(applyRequests.map((r) => r.upstream.branch))).toEqual(new Set([UP_TIP]));
  });

  it('explains a conflict without claiming the change is missing, with the evidence', async () => {
    const user = userEvent.setup();
    const app = renderApp(PAGE);
    await user.click(await screen.findByRole('button', { name: /change shared line/i }));
    expect(app.search().get('commit')).toBe(sha(2));
    const detail = screen.getByRole('region', { name: 'Commit applicability' });
    await waitFor(() => {
      expect(detail).toHaveTextContent(/does not mean the change is missing/i);
    });
    const where = within(detail).getByRole('region', { name: 'Where it conflicts' });
    expect(where).toHaveTextContent('2-down');
    expect(where).toHaveTextContent('2-up');
    const link = within(where).getByRole('link', { name: /compare in snapshots/i });
    const href = new URL(link.getAttribute('href') ?? '', 'http://x');
    expect(href.pathname).toBe(`/u/${USER}/s/s1/folders`);
    expect(href.searchParams.get('leftBranch')).toBe(sha(2));
    expect(href.searchParams.get('rightBranch')).toBe(DOWN_TIP);
    expect(href.searchParams.get('file')).toBe('shared.txt');

    await user.click(within(detail).getByRole('button', { name: 'Show patch' }));
    expect(await within(detail).findByText(/patch against first parent/i)).toBeInTheDocument();
    const patch = within(detail).getByRole('region', { name: /patch against first parent/i });
    expect(patch).toHaveTextContent('shared.txt (modified)');
    expect(patch).toHaveTextContent('+ 2-up');
  });

  it('shows why a commit is already represented', async () => {
    const user = userEvent.setup();
    renderApp(PAGE);
    await user.click(await screen.findByRole('button', { name: /add util/i }));
    const detail = screen.getByRole('region', { name: 'Commit applicability' });
    expect(await within(detail).findByText(/same patch-id/i)).toBeInTheDocument();
    const equivalents = within(detail).getByRole('region', {
      name: /patch-equivalent downstream commits/i,
    });
    expect(equivalents).toHaveTextContent('Add util (cherry-picked)');
    expect(equivalents).toHaveTextContent('committed by Bob');
  });

  it('notes a partially represented clean apply', async () => {
    const user = userEvent.setup();
    renderApp(PAGE);
    await user.click(await screen.findByRole('button', { name: /add feature/i }));
    const detail = screen.getByRole('region', { name: 'Commit applicability' });
    expect(
      await within(detail).findByText(/not show that the change is correct or safe/i),
    ).toBeInTheDocument();
    expect(within(detail).getByText(/partially represented: 1 of 2 files/i)).toBeInTheDocument();
  });

  it('keeps the commit window in the URL', async () => {
    const user = userEvent.setup();
    const app = renderApp(PAGE);
    await screen.findByRole('list', { name: 'Upstream commits' });
    await user.selectOptions(screen.getByLabelText('Number of commits'), '50');
    expect(app.search().get('limit')).toBe('50');
    await user.click(
      screen.getByRole('checkbox', { name: /hide commits downstream already contains/i }),
    );
    expect(app.search().get('hide')).toBe('1');
    await waitFor(() => {
      expect(listRequests.at(-1)).toMatchObject({ limit: 50, hideReachable: true });
    });
    expect(await screen.findByRole('button', { name: /add feature/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /early work/i })).not.toBeInTheDocument();
  });

  it('filters the list by status', async () => {
    const user = userEvent.setup();
    renderApp(PAGE);
    await waitFor(() => {
      expect(
        within(summary()).getByRole('button', { name: /conflicting apply.*1/i }),
      ).toBeInTheDocument();
    });
    await user.click(within(summary()).getByRole('button', { name: /conflicting apply/i }));
    const list = screen.getByRole('list', { name: 'Upstream commits' });
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(list).toHaveTextContent('Change shared line');
  });
});
