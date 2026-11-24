import type { CommitInfo, GitLogCommit, GitSource } from '@om/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useSearchParams } from 'react-router';
import { gitLog } from '../lib/api.ts';
import { shortSha, summarizeAttribution, type CommitShare } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';
import { logUrl, commitUrl, type FileCompareTarget } from '../lib/urls.ts';
import { fileDiffQuery, type SnapshotPair } from '../lib/snapshot-diff.ts';
import { sourceFromParams, type Side } from '../lib/sources.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/** Commits per page: more load on request. */
const PAGE = 50;

const value = (params: URLSearchParams, name: string): string | undefined => {
  const v = params.get(name);
  return v === null || v === '' ? undefined : v;
};

/** The pinned File Compare this list belongs to, and which side (Left or Right) it lists. */
type CommitListContext = FileCompareTarget & { side: Side; hunk: number | undefined };

function commitListContext(params: URLSearchParams): CommitListContext | undefined {
  const left = sourceFromParams(params, 'left');
  const right = sourceFromParams(params, 'right');
  const leftCommit = value(params, 'leftCommit');
  const rightCommit = value(params, 'rightCommit');
  const leftPath = value(params, 'leftPath');
  const rightPath = value(params, 'rightPath');
  const side = params.get('side');
  const key = leftPath ?? rightPath;
  if (!left || !right || leftCommit === undefined || rightCommit === undefined) return undefined;
  if (key === undefined || (side !== 'left' && side !== 'right')) return undefined;
  const hunkParam = params.get('hunk');
  return {
    left,
    right,
    leftCommit,
    rightCommit,
    side,
    hunk: hunkParam !== null && /^\d+$/.test(hunkParam) ? Number(hunkParam) : undefined,
    target: {
      key,
      ...(leftPath === undefined ? {} : { leftPath }),
      ...(rightPath === undefined ? {} : { rightPath }),
    },
  };
}

/** What a row needs to show: a commit from the log, or one that accounts for the changes. */
type RowCommit = Pick<
  CommitInfo,
  'sha' | 'subject' | 'authorName' | 'authorDate' | 'commitDate'
> & {
  parents?: string[] | undefined;
  body?: string | undefined;
};

type Filter = 'all' | 'touching' | 'accounting';

/**
 * Commit List: one side of a File Compare, in its own tab. One list of the commits this side has
 * and the other does not, with three filters: all of them, those that touched this file, and those
 * that account for the changes on screen. Grouped by day; search; select two to open the range
 * between them in a Range Log.
 */
export function CommitListPage(): JSX.Element {
  const [params] = useSearchParams();
  const context = commitListContext(params);
  if (!context) {
    return (
      <p role="alert" className="m-auto p-8 text-center text-muted">
        This commit list link is incomplete. Open it from a File Compare.
      </p>
    );
  }
  return <CommitList key={JSON.stringify(context)} context={context} />;
}

function CommitList({ context }: { context: CommitListContext }) {
  const workspace = useWorkspace();
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const repos = session.data?.repos ?? [];
  const { left, right, leftCommit, rightCommit, target, side, hunk } = context;

  // This side, and the other side it is compared with (its divergence is "not in the other").
  const mine: GitSource = {
    ...(side === 'left' ? left : right),
    branch: side === 'left' ? leftCommit : rightCommit,
  };
  const other: GitSource = {
    ...(side === 'left' ? right : left),
    branch: side === 'left' ? rightCommit : leftCommit,
  };
  const sidePath = side === 'left' ? target.leftPath : target.rightPath;
  const sideLabel = side === 'left' ? 'Left' : 'Right';

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [isSelecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const paths = filter === 'touching' && sidePath !== undefined ? [sidePath] : undefined;
  const log = useInfiniteQuery({
    queryKey: ['commit-list', user, sessionId, mine, other, paths ?? null] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      gitLog(
        {
          user,
          sessionId,
          source: mine,
          exclude: other,
          withBody: true,
          limit: PAGE,
          skip: pageParam,
          ...(paths === undefined ? {} : { paths }),
        },
        signal,
      ),
    getNextPageParam: (last, all) =>
      last.hasMore ? all.reduce((count, page) => count + page.commits.length, 0) : undefined,
    staleTime: Infinity,
    enabled: filter !== 'accounting',
  });

  // The commits that account for the lines the File Compare shows (or the focused hunk of them).
  const pair: SnapshotPair = {
    user,
    sessionId,
    left: { ...left, branch: leftCommit },
    right: { ...right, branch: rightCommit },
  };
  const visible = useQuery({
    ...fileDiffQuery(pair, target, false, true),
    enabled: filter === 'accounting',
  });
  const accounting: CommitShare[] = (() => {
    const diff = visible.data;
    if (!diff) return [];
    const hunkObject = hunk === undefined ? undefined : diff.hunks[hunk];
    const entries =
      hunkObject === undefined
        ? [{ key: target.key, diff }]
        : [{ key: target.key, diff, hunks: [hunkObject] }];
    return summarizeAttribution(entries).shares.filter((s) =>
      side === 'left' ? s.leftLines > 0 : s.rightLines > 0,
    );
  })();

  const source: RowCommit[] =
    filter === 'accounting'
      ? accounting.map((share) => share.commit)
      : (log.data?.pages.flatMap((page) => page.commits) ?? []).map(
          (commit: GitLogCommit): RowCommit => commit,
        );
  const needle = query.trim().toLowerCase();
  const rows = source.filter(
    (c) =>
      needle === '' ||
      c.subject.toLowerCase().includes(needle) ||
      c.authorName.toLowerCase().includes(needle) ||
      c.sha.startsWith(needle),
  );
  const groups = groupByDay(rows);
  const openCommit = (sha: string) => {
    workspace.open(commitUrl(user, sessionId, mine.repoId, sha));
  };
  const toggle = (sha: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  };
  // The list is newest first, so the one nearer the top is the newer of two selected commits.
  const chosen = rows.filter((c) => selected.has(c.sha));
  const range = chosen.length === 2 ? chosen : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm">
        <GitCommitHorizontal className="size-4 shrink-0 text-muted" aria-hidden />
        <h1 className="font-semibold">{sideLabel} · commits not in the other side</h1>
        <span className="text-xs text-muted">{sourceLabelOf(mine, repos)}</span>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-canvas px-4 py-2 text-sm">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          <FilterChip
            active={filter === 'all'}
            onClick={() => {
              setFilter('all');
            }}
          >
            All diverging
          </FilterChip>
          <FilterChip
            active={filter === 'touching'}
            disabled={sidePath === undefined}
            onClick={() => {
              setFilter('touching');
            }}
          >
            {sidePath === undefined ? 'Touching this file' : `Touching ${sidePath}`}
          </FilterChip>
          <FilterChip
            active={filter === 'accounting'}
            onClick={() => {
              setFilter('accounting');
            }}
          >
            Accounting for the changes shown
          </FilterChip>
        </div>
        <input
          type="search"
          aria-label="Search commits"
          placeholder="Search subject, author or SHA"
          value={query}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-0.5"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button
          type="button"
          aria-pressed={isSelecting}
          className="touch-target rounded-md border border-line px-2 py-0.5 hover:bg-hover"
          onClick={() => {
            setSelecting((on) => !on);
            setSelected(new Set());
          }}
        >
          Select commits
        </button>
        {range !== undefined && (
          <button
            type="button"
            className="touch-target rounded-md border border-accent bg-accent-soft px-2 py-0.5 text-accent"
            onClick={() => {
              const [top, bottom] = range;
              if (top && bottom) {
                workspace.open(logUrl(user, sessionId, mine.repoId, top.sha, bottom.sha));
              }
            }}
          >
            Log between these
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {filter !== 'accounting' && log.isPending && (
          <p className="flex items-center gap-2 p-6 text-muted">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading commits…
          </p>
        )}
        {filter === 'accounting' && visible.isPending && (
          <p className="flex items-center gap-2 p-6 text-muted">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Finding what accounts for
            the changes…
          </p>
        )}
        {log.isError && (
          <p role="alert" className="p-6 text-error">
            {log.error.message}
          </p>
        )}
        {rows.length === 0 && !log.isPending && !visible.isPending && (
          <p className="p-6 text-center text-muted">
            {filter === 'accounting'
              ? 'No commit accounts for the changes shown here.'
              : 'No commits match.'}
          </p>
        )}
        <ul aria-label="Diverging commits">
          {groups.map((group) => (
            <GroupRows
              key={group.day}
              day={group.day}
              commits={group.commits}
              isSelecting={isSelecting}
              selected={selected}
              onToggle={toggle}
              onOpen={openCommit}
            />
          ))}
        </ul>
        {filter !== 'accounting' && log.hasNextPage && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1 text-sm hover:bg-hover disabled:opacity-50"
              disabled={log.isFetchingNextPage}
              onClick={() => {
                void log.fetchNextPage();
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

function sourceLabelOf(source: GitSource, repos: Array<{ id: string; name: string }>): string {
  const repo = repos.find((r) => r.id === source.repoId);
  return `${repo?.name ?? 'repository'} @ ${shortSha(source.branch)}`;
}

function FilterChip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: JSX.Element | string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      className={clsx(
        'touch-target rounded-full border px-2.5 py-0.5 disabled:opacity-50',
        active ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** One day's heading and its commits. */
function GroupRows({
  day,
  commits,
  isSelecting,
  selected,
  onToggle,
  onOpen,
}: {
  day: string;
  commits: RowCommit[];
  isSelecting: boolean;
  selected: ReadonlySet<string>;
  onToggle: (sha: string) => void;
  onOpen: (sha: string) => void;
}) {
  return (
    <>
      <li className="sticky top-0 z-10 bg-canvas px-4 py-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {dayLabel(day)}
        </h2>
      </li>
      {commits.map((commit) => {
        const isChosen = selected.has(commit.sha);
        const isMerge = (commit.parents?.length ?? 0) > 1;
        return (
          <li
            key={commit.sha}
            className={clsx(
              'flex items-start gap-2 border-b border-line/60 px-4 py-2',
              isChosen && 'bg-accent-soft/60',
            )}
          >
            {isSelecting && (
              <input
                type="checkbox"
                aria-label={commit.subject}
                checked={isChosen}
                className="mt-1.5 size-4 shrink-0"
                onChange={() => {
                  onToggle(commit.sha);
                }}
              />
            )}
            <button
              type="button"
              className="touch-target flex min-h-14 min-w-0 flex-1 items-start gap-3 rounded text-left hover:bg-hover coarse:min-h-14"
              onClick={() => {
                if (isSelecting) onToggle(commit.sha);
                else onOpen(commit.sha);
              }}
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-semibold text-muted"
              >
                {initials(commit.authorName)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{commit.subject}</span>
                  {isMerge && (
                    <span className="rounded bg-hover px-1 text-[11px] text-muted">merge</span>
                  )}
                </span>
                {commit.body !== undefined && commit.body !== '' && (
                  <span className="block truncate text-xs text-muted">
                    {firstLine(commit.body)}
                  </span>
                )}
                <span className="block text-xs text-muted">
                  {commit.authorName} · {formatDate(commit.authorDate)}{' '}
                  <span className="font-mono">{shortSha(commit.sha)}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </>
  );
}

/** Groups commits by the day they were committed, keeping the list's order. */
function groupByDay(commits: RowCommit[]): Array<{ day: string; commits: RowCommit[] }> {
  const groups: Array<{ day: string; commits: RowCommit[] }> = [];
  for (const commit of commits) {
    const day = commit.commitDate.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.commits.push(commit);
    else groups.push({ day, commits: [commit] });
  }
  return groups;
}

/** "Today", "Yesterday", or the date ("2 Jan 2026"). */
function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  const today = new Date();
  const diffDays = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '');
  return (
    parts.length > 1
      ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}`
      : (parts[0]?.slice(0, 2) ?? '')
  ).toUpperCase();
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? '';
}
