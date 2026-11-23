import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const L = '1'.repeat(40);
const R = '2'.repeat(40);
const C1 = 'a'.repeat(40);

const url = (extra = '') =>
  `/u/karthik/s/s1/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev` +
  `&leftCommit=${L}&rightCommit=${R}&leftPath=a.txt&rightPath=a.txt${extra}`;

beforeEach(() => {
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
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
              { kind: 'added', text: 'new', rightLine: 1 },
            ],
          },
        ],
        commits: [
          {
            sha: C1,
            subject: 'Change',
            authorName: 'Ada',
            authorEmail: 'ada@example.com',
            authorDate: '2026-01-02T00:00:00Z',
            committerName: 'Ada',
            committerEmail: 'ada@example.com',
            commitDate: '2026-01-02T00:00:00Z',
            inLeft: true,
            inRight: false,
          },
        ],
      }),
    ),
  );
});

describe('File Compare', () => {
  it('opens side by side, and switching to inline is kept in the URL', async () => {
    const { search } = renderApp(url());
    expect(await screen.findByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Inline' }));
    await waitFor(() => {
      expect(search().get('view')).toBe('inline');
    });
    expect(screen.getByRole('button', { name: 'Inline' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens the diverging commits of Base in a new Commit List tab, leaving this one', async () => {
    const { location } = renderApp(url());
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Base: diverging commits' }));
    await waitFor(() => {
      expect(location().pathname).toMatch(/\/commits$/);
    });
    const params = new URLSearchParams(location().search);
    expect(params.get('side')).toBe('left');
    expect(params.get('leftCommit')).toBe(L);
    expect(params.get('leftPath')).toBe('a.txt');
  });
});
