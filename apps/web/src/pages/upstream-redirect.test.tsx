import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

/*
 * Upstream is now Between. An old Upstream link opens Between with the same two branches, on origin.
 */

const BASE = '/u/karthik/s/s1';

beforeEach(() => {
  server.use(sessionDetailHandler({ repos: [repoInfo()] }));
});

describe('old Upstream links', () => {
  it('open Between with the same repo and the same two branches', async () => {
    const app = renderApp(
      `${BASE}/upstream?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev`,
    );
    await waitFor(() => {
      expect(app.location().pathname).toBe(`${BASE}/between`);
    });
    expect(app.search().get('repo')).toBe('r1');
    expect(app.search().get('left')).toBe('origin/main');
    expect(app.search().get('right')).toBe('origin/dev');
  });

  it('go to the Overview when they name no branches', async () => {
    const app = renderApp(`${BASE}/upstream`);
    await waitFor(() => {
      expect(app.location().pathname).toBe(BASE);
    });
    expect(await screen.findByRole('region', { name: 'Compare' })).toBeInTheDocument();
  });
});
