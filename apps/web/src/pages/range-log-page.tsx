import type { GitLogCommit } from '@om/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useSearchParams } from 'react-router';
import { CommitFiles } from '../components/commit-files.tsx';
import type { DiffLayout } from '../components/snapshot-diff-view.tsx';
import { gitLog, gitShow } from '../lib/api.ts';
import { shortSha } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';
import { commitUrl } from '../lib/urls.ts';
import { useSessionParams } from '../lib/session.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/** Commits per page: more load on request. */
const PAGE = 50;

/**
 * Range Log: the serialized history from `top` (latest) down to `bottom` (older): the commits
 * `top` has and `bottom` does not, newest first, with `bottom` itself as the end of the range.
 * Each commit expands to its changes on request.
 */
export function RangeLogPage(): JSX.Element {
  const [params] = useSearchParams();
  const repoId = params.get('repo') ?? '';
  const top = params.get('top') ?? '';
  const bottom = params.get('bottom') ?? '';
  if (repoId === '' || top === '' || bottom === '') {
    return (
      <p role="alert" className="m-auto p-8 text-center text-muted">
        This range link is incomplete. Open a range from a commit list or a commit.
      </p>
    );
  }
  return <RangeLog key={`${repoId}/${top}/${bottom}`} repoId={repoId} top={top} bottom={bottom} />;
}

function RangeLog({ repoId, top, bottom }: { repoId: string; top: string; bottom: string }) {
  const { user, sessionId } = useSessionParams();
  const workspace = useWorkspace();
  const source = { type: 'git' as const, repoId, branch: top };
  const bottomSource = { type: 'git' as const, repoId, branch: bottom };

  const pages = useInfiniteQuery({
    queryKey: ['git-log', user, sessionId, repoId, top, bottom] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      gitLog(
        {
          user,
          sessionId,
          source,
          exclude: bottomSource,
          withBody: true,
          withStats: true,
          limit: PAGE,
          skip: pageParam,
        },
        signal,
      ),
    getNextPageParam: (last, all) =>
      last.hasMore ? all.reduce((count, page) => count + page.commits.length, 0) : undefined,
    staleTime: Infinity,
  });

  // The bottom commit's own details: it closes the range, so it is shown even though it is excluded.
  const end = useQuery({
    queryKey: ['git-log-end', user, sessionId, repoId, bottom] as const,
    queryFn: async ({ signal }) => {
      const log = await gitLog({ user, sessionId, source: bottomSource, limit: 1 }, signal);
      return log.commits[0];
    },
    staleTime: Infinity,
  });

  if (pages.isError) {
    return (
      <div
        role="alert"
        className="m-4 rounded-md border border-error/40 bg-error-soft p-4 text-error"
      >
        {pages.error.message}
      </div>
    );
  }
  if (!pages.data) {
    return (
      <p className="m-auto flex items-center gap-2 p-8 text-muted">
        <LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading the range…
      </p>
    );
  }
  const first = pages.data.pages[0];
  const commits: GitLogCommit[] = pages.data.pages.flatMap((page) => page.commits);
  const total = first?.total ?? 0;
  const isNotInHistory = first?.excludeIsAncestor === false;
  const isSingleCommit = first !== undefined && first.exclude?.commit === first.include.commit;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-1 border-b border-line bg-surface px-4 py-3">
        <h1 className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <GitCommitHorizontal className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="font-mono text-sm">{shortSha(top)}</span>
          <span aria-hidden className="text-muted">
            →
          </span>
          <span className="font-mono text-sm">{shortSha(bottom)}</span>
          <span className="text-sm font-normal text-muted">
            {isSingleCommit ? '· one commit' : `· ${total} commit${total === 1 ? '' : 's'}`}
          </span>
        </h1>
        {isNotInHistory && (
          <p
            role="note"
            className="rounded-md border border-modified/40 bg-modified-soft px-3 py-1.5 text-xs text-modified"
          >
            {`${shortSha(bottom)} is not in ${shortSha(top)}'s history; showing commits in ${shortSha(top)} that are not in ${shortSha(bottom)}.`}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <ul aria-label="Commits in the range" className="divide-y divide-line">
          {isSingleCommit
            ? null
            : commits.map((commit) => (
                <RangeEntry
                  key={commit.sha}
                  commit={commit}
                  onOpen={() => {
                    workspace.open(commitUrl(user, sessionId, repoId, commit.sha));
                  }}
                  scope={{ user, sessionId, repoId }}
                />
              ))}
          {end.data !== undefined && (
            <li aria-label="End of range" className="bg-hover/40 px-4 py-2 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted">End of range</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{shortSha(end.data.sha)}</span>
                <span className="font-medium">{end.data.subject}</span>
              </div>
            </li>
          )}
        </ul>
        {pages.hasNextPage && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1 text-sm hover:bg-hover disabled:opacity-50"
              disabled={pages.isFetchingNextPage}
              onClick={() => {
                void pages.fetchNextPage();
              }}
            >
              Load more commits
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One commit of the range: its message and changed files, with its diff on request. */
function RangeEntry({
  commit,
  onOpen,
  scope,
}: {
  commit: GitLogCommit;
  onOpen: () => void;
  scope: { user: string; sessionId: string; repoId: string };
}) {
  const [isExpanded, setExpanded] = useState(false);
  const [layout, setLayout] = useState<DiffLayout>('side');
  const { user, sessionId, repoId } = scope;
  const changes = useQuery({
    queryKey: ['git-show', user, sessionId, repoId, commit.sha] as const,
    queryFn: ({ signal }) =>
      gitShow({ user, sessionId, source: { type: 'git', repoId, branch: commit.sha } }, signal),
    enabled: isExpanded,
    staleTime: Infinity,
  });
  const files = commit.files ?? [];
  return (
    <li aria-label={commit.subject} className="px-4 py-2">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-muted">{shortSha(commit.sha)}</span>
        <span className="min-w-0 flex-1 font-medium">{commit.subject}</span>
        <button
          type="button"
          className="touch-target rounded border border-line px-2 py-0.5 text-xs hover:bg-hover"
          onClick={onOpen}
        >
          Open commit
        </button>
      </div>
      <p className="text-xs text-muted">
        {commit.authorName} · {formatDate(commit.authorDate)}
      </p>
      {commit.body !== undefined && commit.body !== '' && (
        <p className="mt-1 whitespace-pre-line text-sm text-ink/90">{commit.body}</p>
      )}
      {files.length > 0 && (
        <ul className="mt-1 space-y-0.5 font-mono text-xs">
          {files.map((file) => (
            <li key={`${file.oldPath ?? ''}\u0000${file.path}`} className="flex gap-2">
              <span className="min-w-0 truncate">
                {file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path}
              </span>
              {file.binary ? (
                <span className="text-muted">binary</span>
              ) : (
                <span className="shrink-0 tabular-nums">
                  <span className="text-side-right">+{file.additions}</span>{' '}
                  <span className="text-side-left">−{file.deletions}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        aria-expanded={isExpanded}
        className="touch-target mt-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent hover:bg-hover"
        onClick={() => {
          setExpanded((open) => !open);
        }}
      >
        {isExpanded ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        Show changes
      </button>
      {isExpanded && (
        <div className="mt-2 border-t border-line">
          {changes.isError && (
            <p role="alert" className="p-3 text-error">
              {changes.error.message}
            </p>
          )}
          {changes.data === undefined && !changes.isError && (
            <p className="p-3 text-muted">Loading changes…</p>
          )}
          {changes.data !== undefined && (
            <CommitFiles patch={changes.data} layout={layout} onLayoutChange={setLayout} />
          )}
        </div>
      )}
    </li>
  );
}
