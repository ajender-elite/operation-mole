import type { GitSource, RepoInfo } from '@om/shared';
import clsx from 'clsx';
import { GitBranch, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import { useId, useState, type JSX, type SubmitEvent } from 'react';
import { CompareForm } from '../components/compare-form.tsx';
import { formatRelative } from '../lib/format.ts';
import { useRepoActions, useSessionDetail, useSessionParams } from '../lib/session.ts';
import { foldersUrl, upstreamUrl } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

const card = 'rounded-lg border border-line bg-surface';

/**
 * A session's home. With no repository yet it asks for one and nothing else; once there is
 * one it offers what can now be done with it: compare two snapshots, reopen a recent
 * comparison, keep the repositories up to date.
 */
export function SessionOverviewPage(): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const workspace = useWorkspace();

  if (session.isPending) return <p className="m-auto p-8 text-muted">Loading session…</p>;
  if (session.isError) {
    return (
      <div
        role="alert"
        className="m-4 rounded-md border border-error/40 bg-error-soft p-4 text-error"
      >
        {session.error.message}
      </div>
    );
  }

  const { session: info, repos } = session.data;

  if (repos.length === 0) {
    return (
      <div className="m-auto w-full max-w-lg space-y-4 p-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Add a repository</h1>
          <p className="text-sm text-muted">
            OM clones it into <span className="font-medium text-ink">{info.name}</span>; then you
            can compare its branches.
          </p>
        </div>
        <AddRepoForm user={user} sessionId={sessionId} isPrimary />
      </div>
    );
  }

  const openFolders = (l: GitSource, r: GitSource) => {
    workspace.open(foldersUrl(user, sessionId, l, r));
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <section aria-label="Compare" className={clsx(card, 'space-y-2 p-4')}>
          <h1 className="text-base font-semibold">Compare two snapshots</h1>
          <CompareForm
            initialLeft={undefined}
            initialRight={undefined}
            repos={repos}
            user={user}
            sessionId={sessionId}
            submitLabel="Compare folders"
            onSubmit={openFolders}
            secondary={{
              label: 'Check upstream commits',
              onSubmit: (l, r) => {
                workspace.open(upstreamUrl(user, sessionId, l, r));
              },
            }}
          />
        </section>

        <RepoSection user={user} sessionId={sessionId} repos={repos} />
      </div>
    </div>
  );
}

function AddRepoForm({
  user,
  sessionId,
  isPrimary = false,
  onAdded,
}: {
  user: string;
  sessionId: string;
  isPrimary?: boolean;
  onAdded?: () => void;
}) {
  const { add } = useRepoActions(user, sessionId);
  const [url, setUrl] = useState('');
  const id = useId();

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (url.trim()) {
      add.mutate(url.trim(), {
        onSuccess: () => {
          setUrl('');
          onAdded?.();
        },
      });
    }
  };

  return (
    <form onSubmit={submit} className={clsx(card, 'flex flex-wrap items-end gap-2 p-3')}>
      <div className="min-w-56 flex-1">
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
          Repository URL
        </label>
        <input
          id={id}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            add.reset();
          }}
          // The page's one job when it is empty.
          autoFocus={isPrimary}
          placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-line bg-canvas px-3 py-1.5 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        />
      </div>
      <button
        type="submit"
        disabled={!url.trim() || add.isPending}
        className={clsx(
          'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm disabled:opacity-50',
          isPrimary
            ? 'bg-accent font-medium text-white hover:bg-accent/90'
            : 'border border-line hover:bg-hover',
        )}
      >
        {add.isPending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <Plus className="size-4" aria-hidden />
        )}
        {add.isPending ? 'Cloning…' : 'Add repository'}
      </button>
      {add.isError && <p className="w-full text-sm text-error">{add.error.message}</p>}
    </form>
  );
}

function RepoSection({
  user,
  sessionId,
  repos,
}: {
  user: string;
  sessionId: string;
  repos: RepoInfo[];
}) {
  const { fetchLatest } = useRepoActions(user, sessionId);
  const [isAdding, setIsAdding] = useState(false);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <GitBranch className="size-4 text-muted" aria-hidden />
          Repositories
        </h2>
        {!isAdding && (
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-accent hover:bg-hover"
            onClick={() => {
              setIsAdding(true);
            }}
          >
            <Plus className="size-4" aria-hidden /> Add another
          </button>
        )}
      </div>
      {isAdding && (
        <AddRepoForm
          user={user}
          sessionId={sessionId}
          onAdded={() => {
            setIsAdding(false);
          }}
        />
      )}
      <ul aria-label="Repositories" className={clsx(card, 'divide-y divide-line overflow-hidden')}>
        {repos.map((repo) => {
          const isFetching = fetchLatest.isPending && fetchLatest.variables === repo.id;
          return (
            <li key={repo.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{repo.name}</p>
                <p className="truncate font-mono text-xs text-muted">{repo.url}</p>
                <p className="text-xs text-muted">
                  {repo.branches.length} {repo.branches.length === 1 ? 'branch' : 'branches'} ·
                  default {repo.defaultBranch} · fetched {formatRelative(repo.fetchedAt)}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Fetch latest for ${repo.name}`}
                disabled={isFetching}
                className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
                onClick={() => {
                  fetchLatest.mutate(repo.id);
                }}
              >
                <RefreshCw className={clsx('size-4', isFetching && 'animate-spin')} aria-hidden />
                Fetch latest
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
