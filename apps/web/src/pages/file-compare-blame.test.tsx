import type { CommitInfo, GitBlame } from '@om/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';
import { fileDiffHandlers } from '../test/file-diff-handlers.ts';

/*
 * Blame in File Compare: each side can be blamed on request, every line of that side (context
 * lines included) gets the last change to it in that side's history, and the choice is in the URL.
 */

const L = '1'.repeat(40);
const R = '2'.repeat(40);
const C1 = 'a'.repeat(40);

const url = () =>
  `/u/karthik/s/s1/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev` +
  `&leftCommit=${L}&rightCommit=${R}&leftPath=a.txt&rightPath=a.txt`;

const commitInfo: CommitInfo = {
  sha: C1,
  subject: 'Change',
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-02T00:00:00Z',
  committerName: 'Ada',
  committerEmail: 'ada@example.com',
  commitDate: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
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
      commits: [{ ...commitInfo, inLeft: true, inRight: false }],
    })),
  );
});

describe('blame in File Compare', () => {
  it('blames a side on request, marks its lines, and keeps the choice in the URL', async () => {
    server.use(
      http.post('*/api/git/blame', async ({ request }) => {
        const body = (await request.json()) as { source: { branch: string }; path: string };
        // The whole file, context lines included: no line list means every line.
        return HttpResponse.json<GitBlame>({
          path: body.path,
          commit: body.source.branch,
          lines: [{ line: 1, commit: C1, origLine: 1, boundary: false }],
          commits: [commitInfo],
        });
      }),
    );
    const user = userEvent.setup();
    const { search } = renderApp(url());

    const toggle = await screen.findByRole('button', { name: 'Blame Left' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);

    await waitFor(() => {
      expect(search().get('blame')).toBe('left');
    });
    expect(screen.getByRole('button', { name: 'Blame Left' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      await screen.findByRole('button', { name: 'Last change in Left: Change' }),
    ).toBeInTheDocument();
  });

  it('opens a blamed line’s commit when its marker is pressed', async () => {
    server.use(
      http.post('*/api/git/blame', async ({ request }) => {
        const body = (await request.json()) as { source: { branch: string }; path: string };
        return HttpResponse.json<GitBlame>({
          path: body.path,
          commit: body.source.branch,
          lines: [{ line: 1, commit: C1, origLine: 1, boundary: false }],
          commits: [commitInfo],
        });
      }),
    );
    const user = userEvent.setup();
    renderApp(`${url()}&blame=left`);
    const marker = await screen.findByRole('button', { name: 'Last change in Left: Change' });
    await user.click(marker);
    // The commit opens in a tab of its own, so the tab bar gains it.
    await waitFor(() => {
      expect(screen.getAllByRole('tab').length).toBeGreaterThan(1);
    });
  });
});
