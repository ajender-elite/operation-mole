import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ChevronRight,
  FileDiff,
  FolderTree,
  GitPullRequestArrow,
  LayoutDashboard,
} from 'lucide-react';
import type { JSX } from 'react';
import { Link, NavLink, Outlet, useMatch } from 'react-router';
import { getSession } from '../lib/api.ts';
import { sessionPath } from '../lib/urls.ts';
import { Logo } from './logo.tsx';
import { ThemeToggle } from './theme-toggle.tsx';

/** Page frame: header with logo, user/session breadcrumb, session navigation and theme toggle. */
export function AppShell(): JSX.Element {
  const userMatch = useMatch('/u/:user/*');
  const sessionMatch = useMatch('/u/:user/s/:sessionId/*');
  const user = nonEmpty(userMatch?.params.user);
  const sessionId = nonEmpty(sessionMatch?.params.sessionId);

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="flex items-center gap-x-4 border-b border-line bg-surface px-4 py-2">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo className="size-7" />
          <span>OM</span>
        </Link>
        {user !== undefined && (
          <nav aria-label="Context" className="flex min-w-0 shrink items-center gap-1 text-sm">
            <Link
              to={`/u/${encodeURIComponent(user)}`}
              className="rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-ink"
            >
              {user}
            </Link>
            {sessionId !== undefined && (
              <>
                <ChevronRight className="size-3.5 text-muted" aria-hidden />
                <SessionName user={user} sessionId={sessionId} />
              </>
            )}
          </nav>
        )}
        {user !== undefined && sessionId !== undefined && (
          <SessionNav user={user} sessionId={sessionId} />
        )}
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

/** A route param, or undefined when it is missing or empty. */
function nonEmpty(param: string | undefined): string | undefined {
  return param === '' ? undefined : param;
}

function SessionName({ user, sessionId }: { user: string; sessionId: string }) {
  const session = useQuery({
    queryKey: ['session', user, sessionId],
    queryFn: () => getSession(user, sessionId),
  });
  return <span className="truncate font-medium">{session.data?.session.name ?? '…'}</span>;
}

function SessionNav({ user, sessionId }: { user: string; sessionId: string }) {
  const links = [
    { to: sessionPath(user, sessionId), label: 'Overview', icon: LayoutDashboard, end: true },
    { to: sessionPath(user, sessionId, 'folders'), label: 'Folders', icon: FolderTree, end: false },
    { to: sessionPath(user, sessionId, 'files'), label: 'Files', icon: FileDiff, end: false },
    {
      to: sessionPath(user, sessionId, 'upstream'),
      label: 'Upstream',
      icon: GitPullRequestArrow,
      end: false,
    },
  ];
  return (
    <nav aria-label="Main" className="flex gap-1">
      {links.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          aria-label={label}
          title={label}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm',
              isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-hover',
            )
          }
        >
          <Icon className="size-4" aria-hidden />
          <span className="hidden lg:inline">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
