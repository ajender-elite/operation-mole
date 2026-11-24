import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './components/app-shell.tsx';
import { SessionWorkspace } from './components/session-workspace.tsx';
import { FilesRedirect } from './pages/directory-compare-page.tsx';
import { NotFoundPage } from './pages/not-found-page.tsx';
import { SessionsPage } from './pages/sessions-page.tsx';
import { UpstreamRedirect } from './pages/upstream-redirect.tsx';
import { WelcomePage } from './pages/welcome-page.tsx';

/**
 * All app routes. The session lives in the path; inside it, {@link SessionWorkspace} keeps the
 * Overview and every opened comparison in its own tab, each with its state in its own URL.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <WelcomePage /> },
      { path: 'u/:user', element: <SessionsPage /> },
      { path: 'u/:user/s/:sessionId/*', element: <SessionWorkspace /> },
      // The Lab placeholder became Upstream, which is now Between.
      { path: 'u/:user/s/:sessionId/lab', element: <UpstreamRedirect /> },
      // Before File Compare had its own tab, files opened from `/files` links: go to Folders.
      { path: 'u/:user/s/:sessionId/files', element: <FilesRedirect /> },
      // Links from before sessions existed.
      { path: 'directories', element: <Navigate to="/" replace /> },
      { path: 'files', element: <Navigate to="/" replace /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
