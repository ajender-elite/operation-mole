import type { RepoInfo } from '@om/shared';
import clsx from 'clsx';
import { Download, Folder, GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';
import { useId, useState, type JSX } from 'react';
import { formatRelative } from '../lib/format.ts';
import { useRepoActions } from '../lib/session.ts';
import type { SourceDraft } from '../lib/source-draft.ts';

const ADD = 'add';

const field =
  'w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30';
const small = 'mb-1 block text-xs font-medium text-muted';

type SourcePickerProps = {
  /** The side's name in the UI, e.g. "Base" or "Upstream". */
  side: string;
  /** Offer local folders as well as git repos (default true). */
  allowPaths?: boolean;
  value: SourceDraft;
  onChange: (value: SourceDraft) => void;
  repos: RepoInfo[];
  user: string;
  sessionId: string;
};

/** Chooses one side of a comparison: a local folder, or a branch of a git repo in the session. */
export function SourcePicker({
  side,
  allowPaths = true,
  value,
  onChange,
  repos,
  user,
  sessionId,
}: SourcePickerProps): JSX.Element {
  const id = useId();
  const lower = side.toLowerCase();
  const { add, fetchLatest } = useRepoActions(user, sessionId);
  const [isAdding, setIsAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [lastPath, setLastPath] = useState(value.type === 'path' ? value.path : '');

  const repo = value.type === 'git' ? repos.find((r) => r.id === value.repoId) : undefined;
  const shouldShowUrl = value.type === 'git' && (isAdding || repos.length === 0);

  const pickRepo = (r: RepoInfo) => {
    onChange({ type: 'git', repoId: r.id, branch: r.defaultBranch });
  };

  const setType = (type: SourceDraft['type']) => {
    if (type === value.type) return;
    if (type === 'path') onChange({ type: 'path', path: lastPath });
    else {
      if (value.type === 'path') setLastPath(value.path);
      onChange({ type: 'git', repoId: '', branch: '' });
    }
  };

  return (
    <fieldset className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <legend className="text-sm font-semibold">{side}</legend>
        <div
          hidden={!allowPaths}
          role="radiogroup"
          aria-label={`${side} source`}
          className="flex overflow-hidden rounded-md border border-line text-xs"
        >
          {(
            [
              ['path', 'Folder', Folder],
              ['git', 'Git repo', GitBranch],
            ] as const
          ).map(([type, label, Icon]) => (
            <label
              key={type}
              className={clsx(
                'flex cursor-pointer items-center gap-1 px-2 py-1',
                value.type === type ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover',
              )}
            >
              <input
                type="radio"
                name={`${id}-type`}
                className="sr-only"
                checked={value.type === type}
                onChange={() => {
                  setType(type);
                }}
              />
              <Icon className="size-3.5" aria-hidden />
              {label}
            </label>
          ))}
        </div>
      </div>

      {value.type === 'path' ? (
        <div>
          <label htmlFor={`${id}-path`} className={small}>
            {side} folder
          </label>
          <input
            id={`${id}-path`}
            className={clsx(field, 'font-mono')}
            value={value.path}
            onChange={(e) => {
              onChange({ type: 'path', path: e.target.value });
            }}
            placeholder="/absolute/path"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      ) : (
        <div className="space-y-2">
          {repos.length > 0 && (
            <div>
              <label htmlFor={`${id}-repo`} className={small}>
                {side} repository
              </label>
              <select
                id={`${id}-repo`}
                className={field}
                value={isAdding ? ADD : value.repoId}
                onChange={(e) => {
                  if (e.target.value === ADD) {
                    setIsAdding(true);
                    return;
                  }
                  setIsAdding(false);
                  const chosen = repos.find((r) => r.id === e.target.value);
                  if (chosen) pickRepo(chosen);
                }}
              >
                <option value="" disabled>
                  Choose a repository…
                </option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} — {r.url}
                  </option>
                ))}
                <option value={ADD}>Add a repository…</option>
              </select>
            </div>
          )}

          {shouldShowUrl && (
            <div>
              <label htmlFor={`${id}-url`} className={small}>
                {side} repository URL
              </label>
              <div className="flex gap-2">
                <input
                  id={`${id}-url`}
                  className={clsx(field, 'font-mono')}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    add.reset();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (url.trim()) {
                        add.mutate(url.trim(), {
                          onSuccess: (r) => {
                            pickRepo(r);
                            setIsAdding(false);
                            setUrl('');
                          },
                        });
                      }
                    }
                  }}
                  placeholder="https://github.com/org/repo.git"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  aria-label={`Clone ${lower} repository`}
                  disabled={!url.trim() || add.isPending}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-line px-3 text-sm hover:bg-hover disabled:opacity-50"
                  onClick={() => {
                    add.mutate(url.trim(), {
                      onSuccess: (r) => {
                        pickRepo(r);
                        setIsAdding(false);
                        setUrl('');
                      },
                    });
                  }}
                >
                  {add.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="size-4" aria-hidden />
                  )}
                  {add.isPending ? 'Cloning…' : 'Clone'}
                </button>
              </div>
              {add.isError && <p className="mt-1 text-xs text-error">{add.error.message}</p>}
            </div>
          )}

          {repo && !isAdding && (
            <div>
              <label htmlFor={`${id}-branch`} className={small}>
                {side} branch
              </label>
              <div className="flex gap-2">
                <select
                  id={`${id}-branch`}
                  className={clsx(field, 'font-mono')}
                  value={value.branch}
                  onChange={(e) => {
                    onChange({ type: 'git', repoId: repo.id, branch: e.target.value });
                  }}
                >
                  {!repo.branches.includes(value.branch) && value.branch && (
                    <option value={value.branch}>{value.branch} (not found)</option>
                  )}
                  {repo.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Fetch latest for ${lower} repository`}
                  title={`Fetch latest from ${repo.url} (last fetched ${formatRelative(repo.fetchedAt)})`}
                  disabled={fetchLatest.isPending}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2.5 text-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
                  onClick={() => {
                    fetchLatest.mutate(repo.id);
                  }}
                >
                  <RefreshCw
                    className={clsx('size-4', fetchLatest.isPending && 'animate-spin')}
                    aria-hidden
                  />
                  <span className="hidden sm:inline">Fetch latest</span>
                </button>
              </div>
              {fetchLatest.isError && (
                <p className="mt-1 text-xs text-error">{fetchLatest.error.message}</p>
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
