import type { SessionSummary } from '@om/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, LogOut, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type JSX, type SubmitEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { createSession, deleteSession, listSessions } from '../lib/api.ts';
import { formatRelative } from '../lib/format.ts';
import { useServerInfo } from '../lib/server.ts';
import { sessionPath } from '../lib/urls.ts';
import { clearStoredUser } from '../lib/user.ts';

/** Lists, creates and deletes the user's sessions. */
export function SessionsPage(): JSX.Element {
  const user = useParams()['user'] ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const id = useId();

  const sessions = useQuery({ queryKey: ['sessions', user], queryFn: () => listSessions(user) });
  const limit = useServerInfo().data?.limits.sessionsPerUser;
  const isAtLimit = sessions.isSuccess && limit !== undefined && sessions.data.length >= limit;

  const create = useMutation({
    mutationFn: (sessionName: string) => createSession(user, sessionName),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', user] });
      void navigate(sessionPath(user, session.id));
    },
  });

  const remove = useMutation({
    mutationFn: (session: SessionSummary) => deleteSession(user, session.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions', user] }),
  });

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 overflow-auto p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{user}’s sessions</h1>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink"
          onClick={() => {
            clearStoredUser();
            void navigate('/');
          }}
        >
          <LogOut className="size-4" aria-hidden />
          Switch user
        </button>
      </div>

      {sessions.isSuccess && limit !== undefined && (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            Sessions {sessions.data.length} of {limit}
          </p>
          {isAtLimit && (
            <p className="text-sm text-muted">
              You have {limit} sessions. Delete one to start another.
            </p>
          )}
        </div>
      )}

      <form
        onSubmit={submit}
        className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <div className="min-w-48 flex-1">
          <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
            New session name
          </label>
          <input
            id={id}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              create.reset();
            }}
            maxLength={60}
            disabled={isAtLimit}
            placeholder="e.g. Release 2.4 review"
            className="w-full rounded-md border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <button
          type="submit"
          disabled={!name.trim() || create.isPending || isAtLimit}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden />
          Create session
        </button>
        {create.isError && (
          <p role="alert" className="w-full text-sm text-error">
            {create.error.message}
          </p>
        )}
      </form>

      {sessions.isPending ? (
        <p className="text-muted">Loading sessions…</p>
      ) : sessions.isError ? (
        <p role="alert" className="text-error">
          {sessions.error.message}
        </p>
      ) : sessions.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-8 text-center text-muted">
          No sessions yet. Create one to start comparing.
        </p>
      ) : (
        <ul
          aria-label="Sessions"
          className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
        >
          {sessions.data.map((session) => (
            <li key={session.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-hover">
              <FolderGit2 className="size-5 shrink-0 text-accent" aria-hidden />
              <Link to={sessionPath(user, session.id)} className="min-w-0 flex-1">
                <span className="block truncate font-medium">{session.name}</span>
                <span className="text-xs text-muted">
                  {session.repoCount} {session.repoCount === 1 ? 'repo' : 'repos'} · used{' '}
                  {formatRelative(session.updatedAt)}
                </span>
              </Link>
              <button
                type="button"
                aria-label={`Delete ${session.name}`}
                title="Delete session and its cloned repos"
                className="rounded p-1.5 text-muted opacity-0 hover:bg-error-soft hover:text-error focus:opacity-100 group-hover:opacity-100"
                onClick={() => {
                  if (window.confirm(`Delete "${session.name}" and all repos cloned in it?`)) {
                    remove.mutate(session);
                  }
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
