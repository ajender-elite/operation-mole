import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './components/app-shell.tsx';
import { DirectoryComparePage } from './pages/directory-compare-page.tsx';
import { FileComparePage } from './pages/file-compare-page.tsx';
import { NotFoundPage } from './pages/not-found-page.tsx';
import { SessionOverviewPage } from './pages/session-overview-page.tsx';
import { SessionsPage } from './pages/sessions-page.tsx';
import { LabRedirect, UpstreamPage } from './pages/upstream-page.tsx';
import { WelcomePage } from './pages/welcome-page.tsx';

/** All app routes. The session lives in the path; each page keeps its own state in the query. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <WelcomePage /> },
      { path: 'u/:user', element: <SessionsPage /> },
      { path: 'u/:user/s/:sessionId', element: <SessionOverviewPage /> },
      { path: 'u/:user/s/:sessionId/folders', element: <DirectoryComparePage /> },
      { path: 'u/:user/s/:sessionId/files', element: <FileComparePage /> },
      { path: 'u/:user/s/:sessionId/upstream', element: <UpstreamPage /> },
      // The Lab placeholder became Upstream.
      { path: 'u/:user/s/:sessionId/lab', element: <LabRedirect /> },
      // Links from before sessions existed.
      { path: 'directories', element: <Navigate to="/" replace /> },
      { path: 'files', element: <Navigate to="/" replace /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
