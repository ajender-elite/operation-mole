import type { SnapshotFileDiff } from '@om/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitInfo } from '../test/explore-handlers.ts';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * A file with the same content on both sides: the plain diff says so, and File Compare still shows both
 * panes with the whole text, from the full-file diff (one context hunk).
 */

const L = '1'.repeat(40);
const R = '2'.repeat(40);

const url =
  `/u/karthik/s/s1/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev` +
  `&leftCommit=${L}&rightCommit=${R}&leftPath=readme.txt&rightPath=readme.txt`;

const identical = (fullFile: boolean): SnapshotFileDiff => ({
  leftCommit: L,
  rightCommit: R,
  leftPath: 'readme.txt',
  rightPath: 'readme.txt',
  content: 'identical',
  commits: [],
  hunks: fullFile
    ? [
        {
          header: '@@ -1,2 +1,2 @@',
          leftStart: 1,
          leftCount: 2,
          rightStart: 1,
          rightCount: 2,
          lines: [
            { kind: 'context', text: 'Hello there', leftLine: 1, rightLine: 1 },
            { kind: 'context', text: 'the same on both sides', leftLine: 2, rightLine: 2 },
          ],
        },
      ]
    : [],
});

let fullFileRequests = 0;

beforeEach(() => {
  fullFileRequests = 0;
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/diff', async ({ request }) => {
      const body = (await request.json()) as { fullFile?: boolean };
      if (body.fullFile === true) fullFileRequests += 1;
      return HttpResponse.json({ files: [identical(body.fullFile === true)] });
    }),
  );
});

describe('File Compare of identical content', () => {
  it('shows both panes with the whole text, not only a notice', async () => {
    renderApp(url);
    // Both sides show each line: one pane for Left, one for Right.
    const lines = await screen.findAllByText('the same on both sides');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Same content on both sides/)).toBeNull();
    expect(fullFileRequests).toBe(1);
  });

  it('does not ask for the whole text of a file that changed', async () => {
    server.use(
      http.post('*/api/git/diff', () =>
        HttpResponse.json({
          files: [
            {
              leftCommit: L,
              rightCommit: R,
              leftPath: 'readme.txt',
              rightPath: 'readme.txt',
              content: 'text',
              commits: [],
              hunks: [],
            } satisfies SnapshotFileDiff,
          ],
        }),
      ),
    );
    renderApp(url);
    // Give the page a moment to settle, then check no full-file request was sent.
    await screen.findByRole('button', { name: 'Side by side' });
    expect(fullFileRequests).toBe(0);
  });
});

describe('File Compare of identical content: lines changed by different commits', () => {
  // Both sides have the same text. Line 1 was last changed by the same commit on each side; line 2 by a
  // different one: the side on the left changed it in its own history, the right in another.
  const C1 = 'c'.repeat(40);
  const C2 = 'd'.repeat(40);
  const C3 = 'e'.repeat(40);
  beforeEach(() => {
    server.use(
      http.post('*/api/git/blame', async ({ request }) => {
        const body = (await request.json()) as { source: { branch: string }; path: string };
        const isLeft = body.source.branch === L;
        const second = isLeft ? C2 : C3;
        return HttpResponse.json({
          path: body.path,
          commit: body.source.branch,
          lines: [
            { line: 1, commit: C1, origLine: 1, boundary: true },
            { line: 2, commit: second, origLine: 2, boundary: true },
          ],
          commits: [
            commitInfo(C1, 'Add readme'),
            commitInfo(C2, 'Edit on left'),
            commitInfo(C3, 'Edit on right'),
          ],
        });
      }),
    );
  });

  it('marks the line whose last change differs, counts it, and steps to it', async () => {
    renderApp(url);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-differs][data-side="left"]')).toHaveLength(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 line is last changed by a different commit on each side',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next difference' }));
    expect(
      document.querySelector('[data-differs][data-side="left"]')?.closest('[role="row"]'),
    ).not.toBeNull();
  });

  it('marks nothing when both histories last changed every line by the same commit', async () => {
    server.use(
      http.post('*/api/git/blame', async ({ request }) => {
        const body = (await request.json()) as { path: string };
        return HttpResponse.json({
          path: body.path,
          commit: C1,
          lines: [
            { line: 1, commit: C1, origLine: 1, boundary: true },
            { line: 2, commit: C1, origLine: 2, boundary: true },
          ],
          commits: [commitInfo(C1, 'Add readme')],
        });
      }),
    );
    renderApp(url);
    await screen.findAllByText('the same on both sides');
    expect(document.querySelectorAll('[data-differs]')).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('File Compare of identical content: n and p step through the differing lines', () => {
  it('moves to the next and the previous differing line with n and p', async () => {
    const C1 = 'c'.repeat(40);
    server.use(
      http.post('*/api/git/blame', async ({ request }) => {
        const body = (await request.json()) as { path: string; source: { branch: string } };
        const isLeft = body.source.branch === L;
        return HttpResponse.json({
          path: body.path,
          commit: body.source.branch,
          lines: [
            { line: 1, commit: C1, origLine: 1, boundary: true },
            {
              line: 2,
              commit: isLeft ? 'd'.repeat(40) : 'e'.repeat(40),
              origLine: 2,
              boundary: true,
            },
          ],
          commits: [
            commitInfo(C1, 'Add readme'),
            commitInfo('d'.repeat(40), 'Edit on the left'),
            commitInfo('e'.repeat(40), 'Edit on the right'),
          ],
        });
      }),
    );
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    try {
      renderApp(url);
      await waitFor(() => {
        expect(document.querySelectorAll('[data-differs][data-side="left"]')).toHaveLength(1);
      });
      screen.getByRole('region', { name: 'Snapshot diff' }).focus();
      await userEvent.keyboard('n');
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]).toHaveAttribute('data-differs');
      await userEvent.keyboard('p');
      expect(scrolled).toHaveLength(2);
      expect(scrolled[1]).toBe(scrolled[0]);
    } finally {
      scroll.mockRestore();
    }
  });
});
