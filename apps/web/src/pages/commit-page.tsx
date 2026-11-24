import type { CommitPatch } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Copy, GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { useState, type JSX, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { CommitFiles } from '../components/commit-files.tsx';
import type { DiffLayout } from '../components/snapshot-diff-view.tsx';
import { gitLog, gitShow } from '../lib/api.ts';
import { shortSha } from '../lib/attribution.ts';
import { copyText } from '../lib/clipboard.ts';
import { countLines, fileAnchor, patchPath } from '../lib/commit-patch.ts';
import { formatDate } from '../lib/dates.ts';
import { commitUrl, logUrl } from '../lib/urls.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { sourceLabel } from '../lib/sources.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/**
 * Commit tab: one commit, as a reader wants it. Its message and who wrote it, its parents (each
 * opens its own Commit tab), then every changed file against the first parent, with a summary to
 * filter and jump to them. The range form opens a Range Log from this commit down to another.
 */
export function CommitPage(): JSX.Element {
  const [params] = useSearchParams();
  const repoId = params.get('repo') ?? '';
  const sha = params.get('commit') ?? '';
  if (repoId === '' || sha === '') {
    return (
      <p role="alert" className="m-auto p-8 text-center text-muted">
        This commit link is incomplete. Open it from a commit list or a File Compare.
      </p>
    );
  }
  return <CommitDetails key={`${repoId}/${sha}`} repoId={repoId} sha={sha} />;
}

function CommitDetails({ repoId, sha }: { repoId: string; sha: string }) {
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const repos = session.data?.repos ?? [];
  const workspace = useWorkspace();
  const [layout, setLayout] = useState<DiffLayout>('side');
  const [filter, setFilter] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  const patch = useQuery({
    queryKey: ['git-show', user, sessionId, repoId, sha] as const,
    queryFn: ({ signal }) =>
      gitShow({ user, sessionId, source: { type: 'git', repoId, branch: sha } }, signal),
    staleTime: Infinity,
  });
  // The full message: the log of this one commit carries its body.
  const meta = useQuery({
    queryKey: ['commit-meta', user, sessionId, repoId, sha] as const,
    queryFn: async ({ signal }) => {
      const log = await gitLog(
        { user, sessionId, source: { type: 'git', repoId, branch: sha }, limit: 1, withBody: true },
        signal,
      );
      return log.commits[0];
    },
    staleTime: Infinity,
  });

  if (patch.isError) {
    return (
      <div
        role="alert"
        className="m-4 rounded-md border border-error/40 bg-error-soft p-4 text-error"
      >
        {patch.error.message}
      </div>
    );
  }
  if (!patch.data) {
    return (
      <p className="m-auto flex items-center gap-2 p-8 text-muted">
        <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading commit…
      </p>
    );
  }
  const data: CommitPatch = patch.data;
  const { details } = data;
  const body = meta.data?.body;
  const needle = filter.trim().toLowerCase();
  const isCommitterDifferent =
    details.committerName !== details.authorName || details.commitDate !== details.authorDate;

  const openParent = (parent: string) => {
    workspace.open(commitUrl(user, sessionId, repoId, parent));
  };
  const jumpTo = (index: number) => {
    document.getElementById(fileAnchor('commit', index))?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="flex items-start gap-2 text-base font-semibold">
          <GitCommitHorizontal className="mt-1 size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 break-words">{details.subject}</span>
        </h1>
        {body !== undefined && body !== '' && (
          <p className="whitespace-pre-line break-words text-sm text-ink/90">{linkify(body)}</p>
        )}
        <p className="text-xs text-muted">
          {details.authorName} · authored {formatDate(details.authorDate)}
          {isCommitterDifferent
            ? ` · committed by ${details.committerName} ${formatDate(details.commitDate)}`
            : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-sm text-ink">{shortSha(details.sha)}</span>
          <button
            type="button"
            aria-label="Copy SHA"
            className="touch-target flex items-center gap-1 rounded border border-line px-2 py-0.5 hover:bg-hover"
            onClick={() => {
              void copyText(details.sha);
            }}
          >
            <Copy className="size-3.5" aria-hidden /> Copy SHA
          </button>
          {details.parents.length === 0 ? (
            <span className="text-muted">Root commit</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-muted">Parent{details.parents.length === 1 ? '' : 's'}</span>
              {details.parents.map((parent) => (
                <button
                  key={parent}
                  type="button"
                  aria-label={`Open parent ${shortSha(parent)}`}
                  className="touch-target rounded border border-line px-1.5 py-0.5 font-mono hover:bg-hover"
                  onClick={() => {
                    openParent(parent);
                  }}
                >
                  {shortSha(parent)}
                </button>
              ))}
            </span>
          )}
          <span className="text-muted">
            · {sourceLabel({ type: 'git', repoId, branch: sha }, repos)}
          </span>
        </div>
        <form
          className="flex flex-wrap items-center gap-2 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            const bottom = rangeEnd.trim();
            if (bottom !== '') workspace.open(logUrl(user, sessionId, repoId, sha, bottom));
          }}
        >
          <label className="flex items-center gap-2 text-muted">
            Log from here down to
            <input
              aria-label="Range end"
              value={rangeEnd}
              placeholder="branch, tag or SHA"
              className="w-48 rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-ink"
              onChange={(event) => {
                setRangeEnd(event.target.value);
              }}
            />
          </label>
          <button
            type="submit"
            disabled={rangeEnd.trim() === ''}
            className="touch-target rounded-md border border-line px-2.5 py-0.5 hover:bg-hover disabled:opacity-50"
          >
            Open range
          </button>
        </form>
      </header>

      <nav
        aria-label="Files changed"
        className="max-h-44 overflow-auto border-b border-line bg-canvas px-4 py-2 text-sm"
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="Filter files"
            placeholder="Filter files"
            value={filter}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-0.5 text-sm"
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
          <FileTotals patch={data} />
        </div>
        <ul className="space-y-0.5">
          {data.files.map((file, index) => {
            const path = patchPath(file);
            if (needle !== '' && !path.toLowerCase().includes(needle)) return null;
            const counts = countLines(file);
            return (
              <li key={`${file.oldPath ?? ''}\u0000${file.newPath ?? ''}`}>
                <button
                  type="button"
                  className="touch-target flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-0.5 text-left font-mono text-xs hover:bg-hover"
                  onClick={() => {
                    jumpTo(index);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                  {file.binary ? (
                    <span className="font-sans text-muted">binary</span>
                  ) : (
                    <span className="shrink-0 font-sans tabular-nums">
                      <span className="text-side-right">+{counts.additions}</span>{' '}
                      <span className="text-side-left">−{counts.deletions}</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className={clsx('min-h-0 flex-1 overflow-auto')}>
        <CommitFiles
          patch={data}
          layout={layout}
          onLayoutChange={setLayout}
          filter={filter}
          anchorPrefix="commit"
        />
        {data.truncated && (
          <p className="border-t border-line p-3 text-center text-muted">
            This commit was cut short to stay responsive; some files or lines are not shown.
          </p>
        )}
      </div>
    </div>
  );
}

/** Totals of a commit: how many files, and the lines added and removed. */
function FileTotals({ patch }: { patch: CommitPatch }): ReactNode {
  const totals = patch.files.reduce(
    (sum, file) => {
      const counts = countLines(file);
      return {
        additions: sum.additions + counts.additions,
        deletions: sum.deletions + counts.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
  const count = patch.files.length;
  return (
    <span className="shrink-0 text-xs text-muted tabular-nums">
      {count} file{count === 1 ? '' : 's'} ·{' '}
      <span className="text-side-right">+{totals.additions}</span>{' '}
      <span className="text-side-left">−{totals.deletions}</span>
    </span>
  );
}

/** The message with its web addresses as links (other text as it is). */
function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));
    nodes.push(
      <a
        key={`${at}`}
        href={match[0]}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline underline-offset-2"
      >
        {match[0]}
      </a>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
