import type { SnapshotFileDiff } from '@om/shared';
import { waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/* A TypeScript file's diff is coloured by its grammar, with each token in a palette colour. */

const L = '1'.repeat(40);
const R = '2'.repeat(40);
const url =
  `/u/karthik/s/s1/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev` +
  `&leftCommit=${L}&rightCommit=${R}&leftPath=app.ts&rightPath=app.ts`;

const diff: SnapshotFileDiff = {
  leftCommit: L,
  rightCommit: R,
  leftPath: 'app.ts',
  rightPath: 'app.ts',
  content: 'text',
  commits: [],
  hunks: [
    {
      header: '@@ -1 +1 @@',
      leftStart: 1,
      leftCount: 1,
      rightStart: 1,
      rightCount: 1,
      lines: [{ kind: 'added', text: 'const answer = 42;', rightLine: 1 }],
    },
  ],
};

beforeEach(() => {
  server.use(
    sessionDetailHandler({ repos: [repoInfo()] }),
    http.post('*/api/git/diff', () => HttpResponse.json({ files: [diff] })),
  );
});

describe('File Compare: syntax colours', () => {
  it('colours the tokens of a changed line with palette colours', async () => {
    renderApp(url);
    await waitFor(() => {
      const coloured = document.querySelectorAll(
        '[data-kind="added"] span[style*="--color-syntax-"]',
      );
      expect(coloured.length).toBeGreaterThan(0);
    });
  });
});
