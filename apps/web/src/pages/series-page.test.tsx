import type { GitCherryPick } from '@om/shared';
import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { cherryPickHandler, commitInfo, refEntry, refsHandler } from '../test/explore-handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * The Series tab: picks (in order) checked on the branches the user chooses. Each branch's verdict says
 * where the series stops; a refused request says why, and nothing is checked.
 */

const BASE = '/u/karthik/s/s1';
const PICK_1 = '1'.repeat(40);
const PICK_2 = '2'.repeat(40);
const PICK_3 = '3'.repeat(40);

/** A check that applies every pick (PICK_1 would not be in history, PICK_2 applies on top). */
const applies: GitCherryPick = {
  onto: { commit: 'a'.repeat(40), ref: 'main', label: 'app @ main' },
  outcome: 'applies',
  issues: [],
  warnings: [],
  changedPaths: ['lib.c'],
  steps: [
    {
      index: 0,
      commit: { ...commitInfo(PICK_1, 'Fix the lib'), parents: ['9'.repeat(40)] },
      status: 'applies',
      files: ['lib.c'],
      conflictedPaths: [],
      conflictedFiles: [],
      messages: [],
    },
    {
      index: 1,
      commit: { ...commitInfo(PICK_2, 'Fix the test'), parents: [PICK_1] },
      status: 'no-change',
      files: ['test.c'],
      conflictedPaths: [],
      conflictedFiles: [],
      messages: [],
    },
  ],
};

/** A check that stops at the second pick, and never runs the third. */
const stops: GitCherryPick = {
  onto: { commit: 'b'.repeat(40), ref: 'dev', label: 'app @ dev' },
  outcome: 'conflict',
  stoppedAt: 1,
  issues: [],
  warnings: [],
  changedPaths: ['lib.c'],
  steps: [
    {
      index: 0,
      commit: { ...commitInfo(PICK_1, 'Fix the lib'), parents: ['9'.repeat(40)] },
      status: 'applies',
      files: ['lib.c'],
      conflictedPaths: [],
      conflictedFiles: [],
      messages: [],
    },
    {
      index: 1,
      commit: { ...commitInfo(PICK_2, 'Rewrite the lib'), parents: [PICK_1] },
      status: 'conflict',
      files: ['lib.c'],
      conflictedPaths: ['lib.c'],
      conflictedFiles: [
        { path: 'lib.c', text: '<<<<<<< ours\none\n=======\nTWO\n>>>>>>> theirs\n' },
      ],
      messages: [],
    },
    {
      index: 2,
      commit: { ...commitInfo(PICK_3, 'Add a file'), parents: [PICK_2] },
      status: 'not-run',
      files: ['new.txt'],
      conflictedPaths: [],
      conflictedFiles: [],
      messages: [],
    },
  ],
};

/** A request the pre-check refused: nothing ran. */
const refused: GitCherryPick = {
  onto: { commit: 'b'.repeat(40), ref: 'dev', label: 'app @ dev' },
  outcome: 'invalid',
  issues: [
    {
      index: 0,
      commit: '0'.repeat(40),
      problem: 'not-found',
      message: 'Not a commit in this repository',
    },
  ],
  warnings: [],
  steps: [],
  changedPaths: [],
};

beforeEach(() => {
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    refsHandler([refEntry('origin', 'main'), refEntry('upstream', 'dev')]),
  );
});

describe('Series tab: the verdict per branch', () => {
  it('says each branch applies, and where a series stops on another', async () => {
    const requests: unknown[] = [];
    server.use(cherryPickHandler({ 'origin/main': applies, 'upstream/dev': stops }, requests));
    renderApp(
      `${BASE}/series?repo=r1&picks=${PICK_1},${PICK_2},${PICK_3}&onto=origin/main&onto=upstream/dev`,
    );

    const onMain = await screen.findByRole('article', { name: 'Check on origin/main' });
    expect(
      await within(onMain).findByText(
        'Applies through pick 2 of 2: every pick applies, or is already there.',
      ),
    ).toBeInTheDocument();

    const onDev = await screen.findByRole('article', { name: 'Check on upstream/dev' });
    expect(
      await within(onDev).findByText(
        (_text, element) =>
          element?.tagName === 'P' &&
          element.textContent ===
            `Applies through pick 1 of 3 · stops at pick 2 ${PICK_2.slice(0, 8)}: conflict in lib.c`,
      ),
    ).toBeInTheDocument();
    expect(within(onDev).getByText('Would conflict')).toBeInTheDocument();
    expect(within(onDev).getByText('Not checked')).toBeInTheDocument();
    // The conflicted text is shown, so the user can see the markers.
    expect(within(onDev).getByText(/<<<<<<< ours/)).toBeInTheDocument();
    expect(
      within(onDev).getByText(/1 path changed by the picks before the stop/),
    ).toBeInTheDocument();

    // Each branch was asked for the whole series, in order, on its own remote.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ commits: [PICK_1, PICK_2, PICK_3] });
  });

  it('says a series is refused, and lists each refused pick, without running any', async () => {
    server.use(cherryPickHandler({ 'origin/main': refused }));
    renderApp(`${BASE}/series?repo=r1&picks=${'0'.repeat(40)}&onto=origin/main`);
    const article = await screen.findByRole('article', { name: 'Check on origin/main' });
    expect(
      await within(article).findByText(/Not checked: one pick was refused/),
    ).toBeInTheDocument();
    expect(within(article).getByText(/Not a commit in this repository/)).toBeInTheDocument();
    expect(within(article).queryByText('Would apply')).toBeNull();
  });
});

describe('Series tab: editing the picks and the branches', () => {
  it('adds a full commit id to the end of the picks, and refuses anything else', async () => {
    const { router } = renderApp(`${BASE}/series?repo=r1&picks=${PICK_1}`);
    const input = await screen.findByPlaceholderText('40-character commit id');
    await userEvent.type(input, 'not-a-sha');
    await userEvent.click(screen.getByRole('button', { name: 'Add to series' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Paste the full 40-character commit id.');

    await userEvent.clear(input);
    await userEvent.type(input, PICK_2);
    await userEvent.click(screen.getByRole('button', { name: 'Add to series' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('picks')).toBe(
        `${PICK_1},${PICK_2}`,
      );
    });
  });

  it('moves a pick up, which reorders the series', async () => {
    const { router } = renderApp(`${BASE}/series?repo=r1&picks=${PICK_1},${PICK_2}`);
    await userEvent.click(
      await screen.findByRole('button', { name: `Move ${PICK_2.slice(0, 8)} up` }),
    );
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('picks')).toBe(
        `${PICK_2},${PICK_1}`,
      );
    });
  });

  it('checks the series on a branch when that branch is chosen', async () => {
    const { router } = renderApp(`${BASE}/series?repo=r1&picks=${PICK_1}`);
    await userEvent.click(await screen.findByRole('checkbox', { name: /dev/ }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('onto=upstream%2Fdev');
    });
  });

  it('says what to do when no branch is chosen yet', async () => {
    renderApp(`${BASE}/series?repo=r1&picks=${PICK_1}`);
    expect(
      await screen.findByText('Choose the branches to check the commits on.'),
    ).toBeInTheDocument();
  });

  it('explains an incomplete link', async () => {
    renderApp(`${BASE}/series`);
    expect(await screen.findByText(/This series link is incomplete/)).toBeInTheDocument();
  });
});

describe('Series tab: how many checks run at once', () => {
  it('checks at most three branches at a time, and shows each as it arrives', async () => {
    let running = 0;
    let most = 0;
    const branches = ['a', 'b', 'c', 'd', 'e'];
    server.use(
      http.post('*/api/git/cherry-pick', async ({ request }) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 30));
        running -= 1;
        const body = (await request.json()) as { onto: { branch: string } };
        return HttpResponse.json<GitCherryPick>({
          ...applies,
          onto: { ...applies.onto, ref: body.onto.branch },
        });
      }),
    );
    renderApp(
      `${BASE}/series?repo=r1&picks=${PICK_1}&${branches.map((b) => `onto=origin%2F${b}`).join('&')}`,
    );
    expect(
      await screen.findByRole('article', { name: 'Check on origin/e' }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(most).toBeLessThanOrEqual(3);
    expect(most).toBeGreaterThan(0);
  });
});
