import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState, type JSX } from 'react';
import { Link, Outlet, useMatch } from 'react-router';
import { getSession } from '../lib/api.ts';
import { sessionPath } from '../lib/urls.ts';
import { HeaderSlotContext } from './header-slot.tsx';
import { Logo } from './logo.tsx';
import { ServerInfoChip } from './server-info-chip.tsx';
import { ThemeToggle } from './theme-toggle.tsx';

/** Page frame: header with logo, user/session breadcrumb and theme toggle. Sessions add their own tabs. */
export function AppShell(): JSX.Element {
  const userMatch = useMatch('/u/:user/*');
  const sessionMatch = useMatch('/u/:user/s/:sessionId/*');
  const user = nonEmpty(userMatch?.params.user);
  const sessionId = nonEmpty(sessionMatch?.params.sessionId);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="flex items-center gap-x-4 border-b border-line bg-surface px-4 py-2 short:py-1">
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
        <div ref={setHeaderSlot} className="flex min-w-0 flex-1 items-center" />
        <div className="ml-auto">
          <ServerInfoChip />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <HeaderSlotContext.Provider value={headerSlot}>
          <Outlet />
        </HeaderSlotContext.Provider>
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
  return (
    <Link
      to={sessionPath(user, sessionId)}
      className="truncate rounded px-1.5 py-0.5 font-medium hover:bg-hover"
    >
      {session.data?.session.name ?? '…'}
    </Link>
  );
}
