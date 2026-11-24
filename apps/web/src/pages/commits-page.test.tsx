import type { CommitPatch, GitLogRequest } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  commitInfo,
  logCommit,
  logHandler,
  refEntry,
  refsHandler,
} from '../test/explore-handlers.ts';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * The Commits tab: the commits of a ref (or a path, or a range), newest first, with the selected commit's
 * patch beside them. Range Log and the old Commit List, and the History tab, are this tab's older URLs.
 */

const BASE = '/u/karthik/s/s1';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

/** A commit's patch, for the pane (no files: only its details are shown). */
const patchOf = (sha: string, subject: string): CommitPatch => ({
  commit: sha,
  details: { ...commitInfo(sha, subject), parents: ['9'.repeat(40)] },
  baseParent: '9'.repeat(40),
  truncated: false,
  files: [],
});

let requests: GitLogRequest[];
/** The list's requests: a selected commit also asks for its own one-commit log (limit 1), which is not the list. */
const listRequests = () => requests.filter((r) => r.limit !== 1);

beforeEach(() => {
  requests = [];
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/show', async ({ request }) => {
      const body = (await request.json()) as { source: { branch: string } };
      return HttpResponse.json(
        patchOf(
          body.source.branch,
          body.source.branch === SHA_A ? 'Fix the folder' : 'Add the folder',
        ),
      );
    }),
  );
});

const commits = [logCommit(SHA_A, 'Fix the folder'), logCommit(SHA_B, 'Add the folder')];

describe('Commits tab: the list', () => {
  it('lists the commits that touched the path, and asks git only for that path', async () => {
    server.use(logHandler(commits, requests));
    renderApp(`${BASE}/commits?repo=r1&ref=main&path=src`);
    const list = await screen.findByRole('list', { name: 'Commits touching src' });
    expect(within(list).getByText('Fix the folder')).toBeInTheDocument();
    expect(within(list).getByText('Add the folder')).toBeInTheDocument();
    expect(listRequests()[0]?.paths).toEqual(['src']);
  });

  it('selects a commit into the pane, in this tab, and shows its patch there', async () => {
    server.use(logHandler(commits, requests));
    const { router } = renderApp(`${BASE}/commits?repo=r1&ref=main`);
    await userEvent.click(await screen.findByRole('button', { name: /Add the folder/ }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('commit')).toBe(SHA_B);
    });
    expect(router.state.location.pathname).toBe(`${BASE}/commits`);
    const pane = screen.getByRole('region', { name: 'Selected commit' });
    expect(
      await within(pane).findByRole('heading', { name: /Add the folder/ }),
    ).toBeInTheDocument();
  });

  it('moves the selection with j and k', async () => {
    server.use(logHandler(commits, requests));
    const { router } = renderApp(`${BASE}/commits?repo=r1&ref=main&commit=${SHA_A}`);
    await screen.findByRole('list', { name: 'Commits on main' });
    await userEvent.keyboard('j');
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('commit')).toBe(SHA_B);
    });
    await userEvent.keyboard('k');
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('commit')).toBe(SHA_A);
    });
  });

  it('shows the next page when asked for more', async () => {
    server.use(logHandler(commits, requests, true));
    renderApp(`${BASE}/commits?repo=r1&ref=main`);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more commits' }));
    await waitFor(() => {
      expect(listRequests().at(-1)?.limit).toBe(100);
    });
  });
});

describe('Commits tab: narrowing the list', () => {
  it('applies a message filter from the form, to the URL and to git', async () => {
    server.use(logHandler(commits, requests));
    const { router } = renderApp(`${BASE}/commits?repo=r1&ref=main`);
    await screen.findByRole('list', { name: 'Commits on main' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Message contains' }), 'fix');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe('fix');
    });
    await waitFor(() => {
      expect(listRequests().at(-1)?.grep).toBe('fix');
    });
  });

  it('follows renames only for one file: the option is off until a path is given', async () => {
    server.use(logHandler(commits, requests));
    renderApp(`${BASE}/commits?repo=r1&ref=main`);
    await screen.findByRole('list', { name: 'Commits on main' });
    expect(screen.getByRole('checkbox', { name: /Follow renames/ })).toBeDisabled();
  });

  it('asks for the commits following one file through its renames', async () => {
    server.use(logHandler(commits, requests));
    renderApp(`${BASE}/commits?repo=r1&ref=main&path=renamed.txt&follow=1`);
    await screen.findByRole('list', { name: /following renamed.txt/ });
    expect(listRequests().at(-1)).toMatchObject({ paths: ['renamed.txt'], follow: true });
  });
});

describe('Commits tab: older URLs', () => {
  it('sends the History tab of a path to the Commits tab, with the path', async () => {
    server.use(logHandler(commits, requests));
    const { router } = renderApp(`${BASE}/history?repo=r1&ref=main&path=src`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/commits`);
    });
    expect(new URLSearchParams(router.state.location.search).get('path')).toBe('src');
  });

  it('sends the Range Log of top down to bottom to the Commits tab, as the commits not in bottom', async () => {
    server.use(logHandler([logCommit(SHA_C, 'Only in top')], requests));
    const { router } = renderApp(`${BASE}/log?repo=r1&top=aaa&bottom=bbb`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/commits`);
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('ref')).toBe('aaa');
    expect(params.get('notIn')).toBe('bbb');
    await screen.findByRole('list', { name: /not in bbb|Commits on aaa/ });
    expect(listRequests().at(-1)?.exclude).toMatchObject({ branch: 'bbb' });
  });

  it('sends the Commit List of a side to the Commits tab, as that commit not in the other side', async () => {
    server.use(logHandler(commits, requests));
    const { router } = renderApp(
      `${BASE}/commits?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev&leftCommit=${SHA_A}&rightCommit=${SHA_B}&side=left`,
    );
    await waitFor(() => {
      expect(router.state.location.search).not.toContain('side=');
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('ref')).toBe(SHA_A);
    expect(params.get('notIn')).toBe(SHA_B);
  });
});

describe('Commits tab: choosing another branch or tag', () => {
  it('opens the commits of the branch chosen, in a tab of its own', async () => {
    server.use(refsHandler([refEntry('origin', 'main'), refEntry('origin', 'dev')]));
    const { router } = renderApp(`${BASE}/commits?repo=r1&ref=main`);
    await screen.findByRole('option', { name: 'dev' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Branch or tag' }), 'dev');
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('ref')).toBe('dev');
    });
    expect(router.state.location.pathname).toBe(`${BASE}/commits`);
  });
});

describe('Commits tab: first parent and topological order', () => {
  it('asks git for first-parent history and topological order when the form says so', async () => {
    server.use(logHandler(commits, requests));
    const { router } = renderApp(`${BASE}/commits?repo=r1&ref=main`);
    await screen.findByRole('list', { name: 'Commits on main' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'First parent only' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Topological order' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('firstParent')).toBe('1');
    });
    expect(new URLSearchParams(router.state.location.search).get('topo')).toBe('1');
    await waitFor(() => {
      expect(listRequests().at(-1)?.firstParent).toBe(true);
    });
    expect(listRequests().at(-1)?.topoOrder).toBe(true);
  });

  it('keeps both choices when the page is reloaded, and unticking them clears them', async () => {
    server.use(logHandler(commits, requests));
    const { router } = renderApp(`${BASE}/commits?repo=r1&ref=main&firstParent=1&topo=1`);
    await screen.findByRole('list', { name: 'Commits on main' });
    expect(screen.getByRole('checkbox', { name: 'First parent only' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Topological order' })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'First parent only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('firstParent')).toBeNull();
    });
    expect(new URLSearchParams(router.state.location.search).get('topo')).toBe('1');
  });
});
