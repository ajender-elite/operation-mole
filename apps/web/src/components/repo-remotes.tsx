import type { RemoteCheck, RepoInfo } from '@om/shared';
import clsx from 'clsx';
import { LoaderCircle, Plus, RefreshCw, Trash2, Wifi } from 'lucide-react';
import { useId, useState, type JSX, type SubmitEvent } from 'react';
import { formatRelative } from '../lib/format.ts';
import { useServerInfo } from '../lib/server.ts';
import { useRepoActions } from '../lib/session.ts';

const card = 'rounded-lg border border-line bg-surface';

/**
 * The remotes of one repo: each with its own branches and fetch time, and the controls to fetch,
 * remove (not the last one) and add one (up to the server's per-repo limit).
 */
export function RepoRemotes({
  user,
  sessionId,
  repo,
}: {
  user: string;
  sessionId: string;
  repo: RepoInfo;
}): JSX.Element {
  const { fetchRemote, removeRemote, checkRemote } = useRepoActions(user, sessionId);
  const [isAdding, setIsAdding] = useState(false);
  const [checks, setChecks] = useState<Record<string, RemoteCheck>>({});
  const limit = useServerInfo().data?.limits.remotesPerRepo;
  const isAtLimit = limit !== undefined && repo.remotes.length >= limit;
  const hasOtherRemotes = repo.remotes.length > 1;

  return (
    <div className="space-y-2">
      <ul
        aria-label={`Remotes of ${repo.name}`}
        className="divide-y divide-line rounded-md border border-line"
      >
        {repo.remotes.map((remote) => {
          const isFetching =
            fetchRemote.isPending &&
            fetchRemote.variables.repoId === repo.id &&
            fetchRemote.variables.name === remote.name;
          const isRemoving =
            removeRemote.isPending &&
            removeRemote.variables.repoId === repo.id &&
            removeRemote.variables.name === remote.name;
          const isChecking =
            checkRemote.isPending &&
            checkRemote.variables.repoId === repo.id &&
            checkRemote.variables.name === remote.name;
          const check = checks[remote.name];
          return (
            <li key={remote.name} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm font-medium">{remote.name}</p>
                <p className="truncate font-mono text-xs text-muted">{remote.url}</p>
                <p className="text-xs text-muted">
                  {remote.branches.length} {remote.branches.length === 1 ? 'branch' : 'branches'} ·
                  default {remote.defaultBranch} · fetched {formatRelative(remote.fetchedAt)}
                </p>
                {check && (
                  <p
                    role="status"
                    className={clsx('text-xs', check.reachable ? 'text-muted' : 'text-error')}
                  >
                    {check.reachable ? 'Reachable' : check.message || 'Not reachable'}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={`Check access to ${remote.name} for ${repo.name}`}
                disabled={isChecking}
                className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
                onClick={() => {
                  checkRemote.mutate(
                    { repoId: repo.id, name: remote.name },
                    {
                      onSuccess: (result) => {
                        setChecks((previous) => ({ ...previous, [remote.name]: result }));
                      },
                    },
                  );
                }}
              >
                <Wifi className={clsx('size-4', isChecking && 'animate-pulse')} aria-hidden />
                Check access
              </button>
              <button
                type="button"
                aria-label={`Fetch ${remote.name} for ${repo.name}`}
                disabled={isFetching}
                className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
                onClick={() => {
                  fetchRemote.mutate({ repoId: repo.id, name: remote.name });
                }}
              >
                <RefreshCw className={clsx('size-4', isFetching && 'animate-spin')} aria-hidden />
                Fetch
              </button>
              {hasOtherRemotes && (
                <button
                  type="button"
                  aria-label={`Remove remote ${remote.name} from ${repo.name}`}
                  disabled={isRemoving}
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-sm text-muted hover:bg-hover hover:text-error disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Remove remote "${remote.name}" from ${repo.name}?`)) {
                      removeRemote.mutate({ repoId: repo.id, name: remote.name });
                    }
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {isAdding ? (
        <AddRemoteForm
          user={user}
          sessionId={sessionId}
          repoId={repo.id}
          onDone={() => {
            setIsAdding(false);
          }}
        />
      ) : (
        <button
          type="button"
          aria-label={`Add remote to ${repo.name}`}
          disabled={isAtLimit}
          title={
            isAtLimit
              ? `This repository already has ${limit} remotes. Remove one to add another.`
              : undefined
          }
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-accent hover:bg-hover disabled:opacity-50"
          onClick={() => {
            setIsAdding(true);
          }}
        >
          <Plus className="size-4" aria-hidden /> Add remote
        </button>
      )}
    </div>
  );
}

function AddRemoteForm({
  user,
  sessionId,
  repoId,
  onDone,
}: {
  user: string;
  sessionId: string;
  repoId: string;
  onDone: () => void;
}): JSX.Element {
  const { addRemote } = useRepoActions(user, sessionId);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const nameId = useId();
  const urlId = useId();
  const canSubmit = name.trim() !== '' && url.trim() !== '' && !addRemote.isPending;

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    addRemote.mutate(
      { repoId, remote: { name: name.trim(), url: url.trim() } },
      {
        onSuccess: () => {
          setName('');
          setUrl('');
          onDone();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className={clsx(card, 'flex flex-wrap items-end gap-2 p-3')}>
      <div className="w-36">
        <label htmlFor={nameId} className="mb-1 block text-xs font-medium text-muted">
          Remote name
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            addRemote.reset();
          }}
          placeholder="fork"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-line bg-canvas px-3 py-1.5 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        />
      </div>
      <div className="min-w-56 flex-1">
        <label htmlFor={urlId} className="mb-1 block text-xs font-medium text-muted">
          Remote URL
        </label>
        <input
          id={urlId}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            addRemote.reset();
          }}
          placeholder="https://github.com/org/fork.git"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-line bg-canvas px-3 py-1.5 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        />
      </div>
      <button
        type="submit"
        disabled={!canSubmit}
        className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50"
      >
        {addRemote.isPending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <Plus className="size-4" aria-hidden />
        )}
        Add remote
      </button>
      <button
        type="button"
        className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-hover"
        onClick={() => {
          addRemote.reset();
          onDone();
        }}
      >
        Cancel
      </button>
      {addRemote.isError && <p className="w-full text-sm text-error">{addRemote.error.message}</p>}
    </form>
  );
}
