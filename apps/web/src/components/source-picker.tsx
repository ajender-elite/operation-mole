import type { RepoInfo } from '@om/shared';
import clsx from 'clsx';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useId, useState, type JSX } from 'react';
import { formatRelative } from '../lib/format.ts';
import { useRepoActions } from '../lib/session.ts';
import type { SourceDraft } from '../lib/source-draft.ts';

const ADD = 'add';

const field =
  'w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30';
const small = 'mb-1 block text-xs font-medium text-muted';

type SourcePickerProps = {
  /** The side's name in the UI, e.g. "Base" or "Target". */
  side: string;
  value: SourceDraft;
  onChange: (value: SourceDraft) => void;
  repos: RepoInfo[];
  user: string;
  sessionId: string;
};

/**
 * Chooses one side of a comparison: a git repository and a branch the user picks explicitly
 * (nothing is preselected). The session's repositories are listed by name and URL, since the
 * two sides may live on different remotes; "Add a repository…" clones another by URL. With no
 * repository yet, the URL field is all there is.
 */
export function SourcePicker({
  side,
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

  const repo = repos.find((r) => r.id === value.repoId);
  const shouldShowUrl = isAdding || repos.length === 0;

  const cloneUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    add.mutate(trimmed, {
      onSuccess: (r) => {
        onChange({ type: 'git', repoId: r.id, branch: '' });
        setIsAdding(false);
        setUrl('');
      },
    });
  };

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold">{side}</legend>

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
              onChange({ type: 'git', repoId: e.target.value, branch: '' });
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
                  cloneUrl();
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
              onClick={cloneUrl}
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
              <option value="" disabled>
                Choose a branch…
              </option>
              {value.branch !== '' && !repo.branches.includes(value.branch) && (
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
              className="flex shrink-0 items-center rounded-md border border-line px-2 text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
              onClick={() => {
                fetchLatest.mutate(repo.id);
              }}
            >
              <RefreshCw
                className={clsx('size-4', fetchLatest.isPending && 'animate-spin')}
                aria-hidden
              />
            </button>
          </div>
          {fetchLatest.isError && (
            <p className="mt-1 text-xs text-error">{fetchLatest.error.message}</p>
          )}
        </div>
      )}
    </fieldset>
  );
}
