import type { GitSource, RepoInfo } from '@om/shared';
import clsx from 'clsx';
import { GitBranch, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState, type JSX, type SubmitEvent } from 'react';
import { CompareForm } from '../components/compare-form.tsx';
import { RepoRemotes } from '../components/repo-remotes.tsx';
import { useServerInfo } from '../lib/server.ts';
import { useRepoActions, useSessionDetail, useSessionParams } from '../lib/session.ts';
import { foldersUrl, logUrl, upstreamUrl } from '../lib/urls.ts';
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

        <section aria-label="Commit log" className={clsx(card, 'space-y-2 p-4')}>
          <h2 className="text-base font-semibold">Commit log</h2>
          <p className="text-xs text-muted">
            The commits from a top revision (latest) down to a bottom one (older), as one serialized
            history.
          </p>
          <CommitLogForm
            repos={repos}
            onOpen={(repoId, top, bottom) => {
              workspace.open(logUrl(user, sessionId, repoId, top, bottom));
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

/** Two revisions (branch, tag or SHA) of one repository, to open the commit log between them. */
function CommitLogForm({
  repos,
  onOpen,
}: {
  repos: RepoInfo[];
  onOpen: (repoId: string, top: string, bottom: string) => void;
}): JSX.Element {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [top, setTop] = useState('');
  const [bottom, setBottom] = useState('');
  const isReady = repoId !== '' && top.trim() !== '' && bottom.trim() !== '';
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-sm"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (isReady) onOpen(repoId, top.trim(), bottom.trim());
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted">
        Repository
        <select
          value={repoId}
          className="rounded-md border border-line bg-surface px-2 py-1 text-ink"
          onChange={(event) => {
            setRepoId(event.target.value);
          }}
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
        Top (latest)
        <input
          value={top}
          placeholder="branch, tag or SHA"
          className="min-w-0 rounded-md border border-line bg-surface px-2 py-1 font-mono text-ink"
          onChange={(event) => {
            setTop(event.target.value);
          }}
        />
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
        Bottom (older)
        <input
          value={bottom}
          placeholder="branch, tag or SHA"
          className="min-w-0 rounded-md border border-line bg-surface px-2 py-1 font-mono text-ink"
          onChange={(event) => {
            setBottom(event.target.value);
          }}
        />
      </label>
      <button
        type="submit"
        disabled={!isReady}
        className="touch-target rounded-md border border-line px-3 py-1 hover:bg-hover disabled:opacity-50"
      >
        Open commit log
      </button>
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
  const { fetchLatest, remove } = useRepoActions(user, sessionId);
  const [isAdding, setIsAdding] = useState(false);
  const limit = useServerInfo().data?.limits.reposPerSession;
  const isAtLimit = limit !== undefined && repos.length >= limit;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <GitBranch className="size-4 text-muted" aria-hidden />
          Repositories
        </h2>
        {limit !== undefined && (
          <p className="text-xs text-muted">
            Repositories {repos.length} of {limit}
          </p>
        )}
        {!isAdding && (
          <button
            type="button"
            disabled={isAtLimit}
            title={
              isAtLimit
                ? `This session already has ${limit} repositories. Remove one to add another.`
                : undefined
            }
            className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-accent hover:bg-hover disabled:opacity-50"
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
          const isRemoving = remove.isPending && remove.variables === repo.id;
          return (
            <li key={repo.id} className="space-y-2 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 truncate font-medium">{repo.name}</p>
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
                <button
                  type="button"
                  aria-label={`Remove ${repo.name}`}
                  disabled={isRemoving}
                  className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-sm text-muted hover:bg-hover hover:text-error disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Remove "${repo.name}" and its clone from this session?`)) {
                      remove.mutate(repo.id);
                    }
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Remove
                </button>
              </div>
              <RepoRemotes user={user} sessionId={sessionId} repo={repo} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
