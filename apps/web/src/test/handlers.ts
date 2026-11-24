import type { RepoInfo, ServerInfo, SessionDetail, SessionSummary } from '@om/shared';
import { HttpResponse, http, type HttpHandler } from 'msw';

export const USER = 'karthik';

export const sessionSummary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  name: 'Release review',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-21T10:00:00.000Z',
  repoCount: 0,
  ...overrides,
});

export const repoInfo = (overrides: Partial<RepoInfo> = {}): RepoInfo => {
  const repo = {
    id: 'r1',
    url: 'https://github.com/acme/app.git',
    name: 'app',
    defaultBranch: 'main',
    branches: ['dev', 'main'],
    fetchedAt: '2026-11-21T10:00:00.000Z',
    ...overrides,
  };
  // Unless a test gives its own remotes, the repo has one: its first remote, origin.
  const origin = {
    name: 'origin',
    url: repo.url,
    defaultBranch: repo.defaultBranch,
    branches: repo.branches,
    fetchedAt: repo.fetchedAt,
  };
  return { remotes: [origin], ...repo };
};

/** GET handler for one session's detail (header, overview, repo pickers). */
export function sessionDetailHandler(detail: Partial<SessionDetail> = {}): HttpHandler {
  return http.get('*/api/users/:user/sessions/:sessionId', ({ params }) =>
    HttpResponse.json<SessionDetail>({
      user: String(params['user']),
      session: sessionSummary({ id: String(params['sessionId']) }),
      repos: [],
      ...detail,
    }),
  );
}

/** What `GET /api/server` reports, with the given parts replaced. */
export const serverInfo = (overrides: Partial<ServerInfo> = {}): ServerInfo => ({
  git: { version: '2.47.0.windows.2' },
  access: { protocols: ['https', 'ssh'], isInteractive: false, hasSshAgent: false },
  limits: { sessionsPerUser: 10, reposPerSession: 10, remotesPerRepo: 10 },
  ...overrides,
});

/** GET handler for the server's git and limits (the header's git chip, and the pages' counts). */
export function serverInfoHandler(overrides: Partial<ServerInfo> = {}): HttpHandler {
  return http.get('*/api/server', () => HttpResponse.json<ServerInfo>(serverInfo(overrides)));
}
