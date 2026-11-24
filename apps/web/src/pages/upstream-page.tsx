import type {
  ApplicabilityResult,
  ApplicabilityStatus,
  DiffHunk,
  GitSource,
  UpstreamCommit,
  UpstreamCommitList,
} from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CircleCheck,
  CircleHelp,
  Equal,
  FolderTree,
  GitMerge,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import { useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { CompareForm } from '../components/compare-form.tsx';
import { Sheet } from '../components/sheet.tsx';
import { shortSha } from '../lib/attribution.ts';
import { daysAgo, formatDate } from '../lib/dates.ts';
import { usePooledQueries, type PooledTask } from '../lib/pooled-queries.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { MEDIA, useMediaQuery } from '../lib/media.ts';
import { sessionPath } from '../lib/urls.ts';
import { sourceFromParams, sourceLabel, sourcesSearch } from '../lib/sources.ts';
import {
  applicabilityQuery,
  commitsQuery,
  patchQuery,
  pinnedPair,
  type CommitWindow,
  type UpstreamPair,
} from '../lib/upstream.ts';

/** Window parameters kept in the URL next to the two sources. */
const WINDOW_PARAMS = ['limit', 'since', 'hide', 'fp'] as const;
const LIMITS = [10, 20, 50, 100, 200];
/** Applicability evaluations running at once. */
const CONCURRENCY = 3;

type StatusFilter = ApplicabilityStatus | 'pending';

const STATUS: Record<
  ApplicabilityStatus,
  { label: string; className: string; icon: typeof CircleCheck }
> = {
  clean: { label: 'Clean apply', className: 'bg-ok/10 text-ok', icon: CircleCheck },
  represented: {
    label: 'Already represented',
    className: 'bg-accent-soft text-accent',
    icon: Equal,
  },
  conflict: {
    label: 'Conflicting apply',
    className: 'bg-modified-soft text-modified',
    icon: TriangleAlert,
  },
  unknown: { label: 'Unknown', className: 'bg-hover text-muted', icon: CircleHelp },
};

/** Search string with `changes` applied (undefined/empty deletes the key). */
function withParams(params: URLSearchParams, changes: Record<string, string | undefined>): string {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined && value !== '') next.set(key, value);
    else next.delete(key);
  }
  return `?${next}`;
}

/** Old `/lab` links (the placeholder this page replaced) land here with their query. */
export function LabRedirect(): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const location = useLocation();
  return <Navigate replace to={`${sessionPath(user, sessionId, 'upstream')}${location.search}`} />;
}

/**
 * Upstream → downstream commit applicability. Upstream is the left side (`left*` in the URL),
 * downstream the right side (`right*`), so the same snapshots carry over from Folders.
 */
export function UpstreamPage(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const upstream = sourceFromParams(params, 'left');
  const downstream = sourceFromParams(params, 'right');
  const key = JSON.stringify([upstream, downstream]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line bg-surface px-4 py-3">
        {upstream && downstream ? (
          // Once compared, the sources are fixed here (as on Folder Compare); a new comparison starts in the overview.
          <div
            role="group"
            aria-label="Compared"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          >
            <span className="text-muted">Upstream</span>
            <span className="font-mono">{sourceLabel(upstream, session.data?.repos ?? [])}</span>
            <span aria-hidden>→</span>
            <span className="text-muted">Downstream</span>
            <span className="font-mono">{sourceLabel(downstream, session.data?.repos ?? [])}</span>
            <Link
              to={sessionPath(user, sessionId)}
              className="ml-auto text-xs text-accent hover:underline"
            >
              New comparison
            </Link>
          </div>
        ) : (
          <CompareForm
            key={key}
            initialLeft={upstream}
            initialRight={downstream}
            repos={session.data?.repos ?? []}
            user={user}
            sessionId={sessionId}
            labels={['Upstream', 'Downstream']}
            submitLabel="Analyze"
            onSubmit={(l, r) => {
              const next = new URLSearchParams(sourcesSearch(l, r));
              for (const name of WINDOW_PARAMS) {
                const value = params.get(name);
                if (value !== null) next.set(name, value);
              }
              void navigate({ search: `?${next}` });
            }}
          />
        )}
        <p className="text-xs text-muted">
          What happens if each upstream commit is applied to the downstream snapshot? Every commit
          is applied <em>on its own</em> to the same, unmodified downstream commit with{' '}
          <span className="font-mono">git merge-tree</span>: nothing is checked out, committed or
          left behind in any repository.
        </p>
      </div>
      {upstream && downstream ? (
        <Analysis key={key} pair={{ user, sessionId, upstream, downstream }} />
      ) : (
        <p className="m-auto max-w-md p-8 text-center text-muted">
          Choose the upstream branch whose recent commits you want to examine, and the downstream
          branch to apply them to.
        </p>
      )}
    </div>
  );
}

function readWindow(params: URLSearchParams): CommitWindow {
  const limit = Number(params.get('limit'));
  const since = params.get('since');
  return {
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 20,
    since: since !== null && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : undefined,
    hideReachable: params.get('hide') === '1',
    firstParent: params.get('fp') === '1',
  };
}

function Analysis({ pair }: { pair: UpstreamPair }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const window = readWindow(params);
  const selectedSha = params.get('commit') ?? undefined;
  const statusParam = params.get('status');
  const statusFilter: StatusFilter | undefined =
    statusParam === 'clean' ||
    statusParam === 'represented' ||
    statusParam === 'conflict' ||
    statusParam === 'unknown' ||
    statusParam === 'pending'
      ? statusParam
      : undefined;

  const list = useQuery(commitsQuery(pair, window));
  const pinned = list.data ? pinnedPair(pair, list.data) : undefined;
  const tasks: Array<PooledTask<ApplicabilityResult>> =
    pinned && list.data
      ? list.data.commits.map((c) => {
          const options = applicabilityQuery(pinned, c.sha);
          return { id: c.sha, queryKey: options.queryKey, run: (client) => client.query(options) };
        })
      : [];
  const pooled = usePooledQueries(tasks, pinned !== undefined, CONCURRENCY);
  const results = new Map(pooled.results.map((r) => [r.id, r.data]));
  const failures = new Map(pooled.errors.map((e) => [e.id, e.message]));

  const set = (changes: Record<string, string | undefined>, shouldReplace = false) => {
    void navigate({ search: withParams(params, changes) }, { replace: shouldReplace });
  };

  if (list.isPending) return <p className="m-auto p-8 text-muted">Reading upstream history…</p>;
  if (list.isError) {
    return (
      <div
        role="alert"
        className="m-4 rounded-md border border-error/40 bg-error-soft p-4 text-error"
      >
        {list.error.message}
      </div>
    );
  }

  const statusOf = (sha: string): StatusFilter =>
    results.get(sha)?.status ?? (failures.has(sha) ? 'unknown' : 'pending');
  const counts = new Map<StatusFilter, number>();
  for (const c of list.data.commits)
    counts.set(statusOf(c.sha), (counts.get(statusOf(c.sha)) ?? 0) + 1);
  const visible = list.data.commits.filter(
    (c) => statusFilter === undefined || statusOf(c.sha) === statusFilter,
  );
  const selected = list.data.commits.find((c) => c.sha === selectedSha);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WindowBar
        window={window}
        list={list.data}
        isFetching={list.isFetching}
        onChange={(changes) => {
          set({ ...changes, commit: undefined });
        }}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-1.5 text-sm">
        <div role="group" aria-label="Applicability summary" className="flex flex-wrap gap-1">
          {(['clean', 'represented', 'conflict', 'unknown'] as const).map((status) => {
            const { label, icon: Icon } = STATUS[status];
            return (
              <button
                key={status}
                type="button"
                aria-pressed={statusFilter === status}
                className={clsx(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
                  statusFilter === status
                    ? 'border-accent bg-accent-soft'
                    : 'border-line hover:bg-hover',
                )}
                onClick={() => {
                  set({ status: statusFilter === status ? undefined : status }, true);
                }}
              >
                <Icon className="size-3.5" aria-hidden />
                {label}{' '}
                <span className="font-semibold tabular-nums">{counts.get(status) ?? 0}</span>
              </button>
            );
          })}
        </div>
        {pooled.isRunning && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            Evaluated {pooled.done} of {pooled.total}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <CommitList
          commits={visible}
          statusOf={statusOf}
          selected={selectedSha}
          onSelect={(sha) => {
            set({ commit: sha });
          }}
        />
        <Sheet
          title="Commit applicability"
          isOpen={Boolean(selected && pinned)}
          backLabel="Back to commits"
          onClose={() => {
            set({ commit: undefined });
          }}
        >
          <div className="min-h-0 flex-1 overflow-auto border-line lg:border-l">
            {selected && pinned ? (
              <CommitDetail
                commit={selected}
                result={results.get(selected.sha)}
                failure={failures.get(selected.sha)}
                pinned={pinned}
                list={list.data}
              />
            ) : (
              <p className="p-8 text-center text-muted">
                Select an upstream commit to see what applying it to{' '}
                <span className="font-mono">{list.data.downstreamLabel}</span> does, and why.
              </p>
            )}
          </div>
        </Sheet>
      </div>
    </div>
  );
}

function WindowBar({
  window,
  list,
  isFetching,
  onChange,
}: {
  window: CommitWindow;
  list: UpstreamCommitList;
  isFetching: boolean;
  onChange: (changes: Record<string, string | undefined>) => void;
}) {
  // In landscape the window settings fold into one line, so the commit list keeps the height.
  const isShort = useMediaQuery(MEDIA.short);
  const [isWindowOpen, setWindowOpen] = useState(false);
  if (isShort && !isWindowOpen) {
    return (
      <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-1 text-sm">
        <button
          type="button"
          aria-expanded={false}
          className="touch-target rounded px-1.5 py-0.5 text-muted hover:bg-hover"
          onClick={() => {
            setWindowOpen(true);
          }}
        >
          Window: last {window.limit} commits
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2 text-sm">
      <label className="flex items-center gap-1.5">
        Last
        <select
          aria-label="Number of commits"
          className="rounded-md border border-line bg-surface px-1.5 py-0.5"
          value={window.limit}
          onChange={(e) => {
            onChange({ limit: e.target.value });
          }}
        >
          {LIMITS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        commits
      </label>
      <span className="flex items-center gap-1.5">
        <label htmlFor="since">committed since</label>
        <input
          id="since"
          type="date"
          className="rounded-md border border-line bg-surface px-1.5 py-0.5"
          value={window.since ?? ''}
          onChange={(e) => {
            onChange({ since: e.target.value });
          }}
        />
        {[7, 30].map((days) => (
          <button
            key={days}
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-hover"
            onClick={() => {
              onChange({ since: daysAgo(days) });
            }}
          >
            {days} days
          </button>
        ))}
        {window.since !== undefined && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover"
            onClick={() => {
              onChange({ since: undefined });
            }}
          >
            Any time
          </button>
        )}
      </span>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={window.hideReachable}
          onChange={(e) => {
            onChange({ hide: e.target.checked ? '1' : undefined });
          }}
        />
        Hide commits downstream already contains
      </label>
      <label
        className="flex items-center gap-1.5"
        title="git log --first-parent: the mainline, with merges standing for the branches they merged"
      >
        <input
          type="checkbox"
          checked={window.firstParent}
          onChange={(e) => {
            onChange({ fp: e.target.checked ? '1' : undefined });
          }}
        />
        First-parent only
      </label>
      <span
        className="ml-auto flex items-center gap-1 font-mono text-xs text-muted"
        title="The exact commits analyzed"
      >
        {isFetching && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
        {list.upstreamLabel} {shortSha(list.upstream.commit)} → {list.downstreamLabel}{' '}
        {shortSha(list.downstream.commit)}
      </span>
      {list.hasMore && (
        <span className="w-full text-xs text-muted">
          Showing the newest {list.commits.length}; more commits match this window.
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: StatusFilter }) {
  if (status === 'pending') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Evaluating
      </span>
    );
  }
  const { label, className, icon: Icon } = STATUS[status];
  return (
    <span
      className={clsx(
        'flex items-center gap-1 rounded px-1.5 py-px text-xs font-medium',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

function CommitList({
  commits,
  statusOf,
  selected,
  onSelect,
}: {
  commits: UpstreamCommit[];
  statusOf: (sha: string) => StatusFilter;
  selected: string | undefined;
  onSelect: (sha: string) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = commits.findIndex((c) => c.sha === selected);
    const next =
      commits[Math.min(commits.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) onSelect(next.sha);
  };
  if (commits.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted lg:w-[28rem]">No commits in this window.</p>
    );
  }
  return (
    <ul
      aria-label="Upstream commits"
      onKeyDown={onKeyDown}
      className="min-h-0 overflow-auto text-sm lg:w-[28rem] lg:shrink-0"
    >
      {commits.map((c) => (
        <li key={c.sha}>
          <button
            type="button"
            aria-current={c.sha === selected || undefined}
            className={clsx(
              'block w-full border-b border-line/70 px-4 py-2 text-left',
              c.sha === selected ? 'bg-accent-soft' : 'hover:bg-hover',
            )}
            onClick={() => {
              onSelect(c.sha);
            }}
          >
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs text-accent">{shortSha(c.sha)}</span>
              {c.parents.length > 1 && (
                <span className="flex items-center gap-0.5 text-xs text-muted" title="Merge commit">
                  <GitMerge className="size-3.5" aria-hidden /> merge
                </span>
              )}
              <span className="ml-auto">
                <StatusBadge status={statusOf(c.sha)} />
              </span>
            </span>
            <span className="mt-0.5 block truncate font-medium">{c.subject}</span>
            <span className="block truncate text-xs text-muted">
              {c.authorName} · committed {formatDate(c.commitDate)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** What a status means, in the precise terms OM can back with git evidence. */
function explanation(result: ApplicabilityResult, downstream: string): ReactNode {
  const down = <span className="font-mono">{downstream}</span>;
  switch (result.reason) {
    case 'reachable':
      return (
        <>Downstream {down} already contains this exact commit: it is reachable from downstream.</>
      );
    case 'equivalent-patch':
      return (
        <>
          Applying it to {down} changes nothing, and downstream has a commit with the same patch-id
          (below). The commit identities differ; the patch is equivalent.
        </>
      );
    case 'no-effective-change':
      return (
        <>
          Applying it to {down} changes nothing: downstream’s files already match the result. No
          downstream commit has the same patch-id, so the content arrived another way (squashed,
          combined with other changes, or written independently).
        </>
      );
    case 'applies':
      return (
        <>
          Git applies it to {down} without conflicts, and the result differs from downstream. This
          is technical applicability only: it does not show that the change is correct or safe for
          downstream.
        </>
      );
    case 'conflict':
      return (
        <>
          Git cannot apply it to {down} automatically. That does <em>not</em> mean the change is
          missing downstream: downstream may hold an evolved, partial or rewritten form of it, or
          unrelated changes to the same lines.
        </>
      );
    case 'error':
      return <>OM could not classify this commit, so it does not guess.</>;
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

const OUTCOME = {
  applies: { label: 'applies', className: 'bg-ok/10 text-ok' },
  'already-present': { label: 'already matches', className: 'bg-accent-soft text-accent' },
  conflict: { label: 'conflict', className: 'bg-modified-soft text-modified' },
} as const;

function CommitDetail({
  commit,
  result,
  failure,
  pinned,
  list,
}: {
  commit: UpstreamCommit;
  result: ApplicabilityResult | undefined;
  failure: string | undefined;
  pinned: UpstreamPair;
  list: UpstreamCommitList;
}) {
  const [isPatchOpen, setIsPatchOpen] = useState(false);
  const { user, sessionId } = pinned;
  // Folder Compare of the upstream commit's tree against the downstream snapshot, opened in
  // its own tab; for a file, at the file's folder (where the tree shows which sides have it).
  const compareLink = (file?: string) => {
    const upstreamAt: GitSource = { ...pinned.upstream, branch: commit.sha };
    const search = new URLSearchParams(sourcesSearch(upstreamAt, pinned.downstream));
    const folder = file?.split('/').slice(0, -1).join('/') ?? '';
    if (folder !== '') search.set('path', folder);
    return `${sessionPath(user, sessionId, 'folders')}?${search}`;
  };
  const alreadyMatching = result?.files.filter((f) => f.outcome === 'already-present').length ?? 0;

  return (
    <div className="space-y-4 p-4 text-sm">
      <header className="space-y-1">
        <p className="font-mono text-xs text-muted">{commit.sha}</p>
        <h2 className="text-base font-semibold">{commit.subject}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted">Author</dt>
          <dd>
            {commit.authorName} &lt;{commit.authorEmail}&gt; · authored{' '}
            {formatDate(commit.authorDate)}
          </dd>
          <dt className="text-muted">Committer</dt>
          <dd>
            {commit.committerName} &lt;{commit.committerEmail}&gt; · committed{' '}
            {formatDate(commit.commitDate)}
          </dd>
          <dt className="text-muted">Parents</dt>
          <dd className="font-mono">
            {commit.parents.length === 0
              ? 'none (root commit)'
              : commit.parents.map(shortSha).join(' ')}
            {commit.parents.length > 1 && <span className="font-sans text-muted"> (merge)</span>}
          </dd>
          <dt className="text-muted">In downstream</dt>
          <dd>
            {commit.reachableFromDownstream
              ? 'yes, this exact commit is reachable'
              : 'not this exact commit'}
          </dd>
        </dl>
      </header>

      <div className="rounded-md border border-line p-3">
        {result ? (
          <div className="space-y-2">
            <StatusBadge status={result.status} />
            <p className="leading-snug">
              {explanation(result, `${list.downstreamLabel} ${shortSha(result.downstreamCommit)}`)}
            </p>
            {result.status === 'clean' && alreadyMatching > 0 && (
              <p className="leading-snug text-muted">
                Partially represented: {alreadyMatching} of {result.files.length} files it touches
                already match downstream.
              </p>
            )}
            {result.detail !== undefined && (
              <p className="leading-snug text-muted">{result.detail}</p>
            )}
          </div>
        ) : failure !== undefined ? (
          <p role="alert" className="text-error">
            {failure}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-muted">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Applying to downstream…
          </p>
        )}
      </div>

      {result && result.equivalentCommits.length > 0 && (
        <Section title="Patch-equivalent downstream commits">
          <ul className="space-y-1">
            {result.equivalentCommits.map((c) => (
              <li key={c.sha} className="rounded border border-line px-2 py-1">
                <span className="font-mono text-xs text-accent">{shortSha(c.sha)}</span>{' '}
                <span className="font-medium">{c.subject}</span>
                <span className="block text-xs text-muted">
                  {c.authorName} · committed by {c.committerName} {formatDate(c.commitDate)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {result && result.files.length > 0 && (
        <Section title="Files it touches">
          <ul className="space-y-0.5">
            {result.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <span
                  className={clsx(
                    'w-28 shrink-0 rounded px-1.5 text-center text-xs',
                    OUTCOME[f.outcome].className,
                  )}
                >
                  {OUTCOME[f.outcome].label}
                </span>
                <span
                  className="min-w-0 truncate font-mono text-xs"
                  title={f.oldPath === undefined ? f.path : `${f.oldPath} → ${f.path}`}
                >
                  {f.oldPath === undefined ? f.path : `${f.oldPath} → ${f.path}`}
                </span>
                <Link
                  to={compareLink(f.path)}
                  className="ml-auto flex shrink-0 items-center gap-1 text-xs text-accent hover:underline"
                  title="Snapshot compare: the upstream commit’s tree against downstream, with attribution"
                >
                  <FolderTree className="size-3.5" aria-hidden /> Compare
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {result && result.conflicts.length > 0 && (
        <Section title="Where it conflicts">
          <p className="text-xs text-muted">
            Git’s merge result. Between{' '}
            <span className="font-mono">&lt;&lt;&lt;&lt;&lt;&lt;&lt;</span> and{' '}
            <span className="font-mono">=======</span>: downstream’s lines; between{' '}
            <span className="font-mono">=======</span> and{' '}
            <span className="font-mono">&gt;&gt;&gt;&gt;&gt;&gt;&gt;</span>: this commit’s.
          </p>
          {result.conflicts.map((excerpt) => (
            <figure
              key={`${excerpt.path}:${excerpt.startLine}`}
              className="overflow-hidden rounded border border-line"
            >
              <figcaption className="flex items-center gap-2 border-b border-line bg-hover px-2 py-0.5 font-mono text-xs">
                {excerpt.path}:{excerpt.startLine}
                <Link
                  to={compareLink(excerpt.path)}
                  className="ml-auto font-sans text-accent hover:underline"
                >
                  Compare in snapshots
                </Link>
              </figcaption>
              <pre className="overflow-x-auto p-2 text-xs leading-5">
                {excerpt.lines.map((line, i) => (
                  <div
                    key={i}
                    className={clsx(
                      /^(<{7}|={7}|>{7}|\|{7})/.test(line) &&
                        'bg-modified-soft font-semibold text-modified',
                    )}
                  >
                    {line || ' '}
                  </div>
                ))}
              </pre>
            </figure>
          ))}
        </Section>
      )}

      {result && result.messages.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">
            Git’s messages ({result.messages.length})
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-hover p-2 text-xs">
            {result.messages.join('\n')}
          </pre>
        </details>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-expanded={isPatchOpen}
          className="rounded-md border border-line px-2.5 py-1 hover:bg-hover"
          onClick={() => {
            setIsPatchOpen(!isPatchOpen);
          }}
        >
          {isPatchOpen ? 'Hide patch' : 'Show patch'}
        </button>
        <Link
          to={compareLink()}
          className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 hover:bg-hover"
        >
          <FolderTree className="size-4" aria-hidden /> Compare snapshots at this commit
        </Link>
      </div>
      {isPatchOpen && <Patch pinned={pinned} commit={commit.sha} />}
    </div>
  );
}

function Patch({ pinned, commit }: { pinned: UpstreamPair; commit: string }) {
  const patch = useQuery(patchQuery(pinned, commit));
  if (patch.isPending) return <p className="text-muted">Loading patch…</p>;
  if (patch.isError)
    return (
      <p role="alert" className="text-error">
        {patch.error.message}
      </p>
    );
  return (
    <Section
      title={`Patch against ${patch.data.baseParent === undefined ? 'the empty tree' : `first parent ${shortSha(patch.data.baseParent)}`}`}
    >
      {patch.data.files.map((f) => (
        <figure
          key={`${f.oldPath ?? ''}>${f.newPath ?? ''}`}
          className="overflow-hidden rounded border border-line"
        >
          <figcaption className="border-b border-line bg-hover px-2 py-0.5 font-mono text-xs">
            {f.status === 'renamed'
              ? `${f.oldPath ?? ''} → ${f.newPath ?? ''}`
              : (f.newPath ?? f.oldPath)}{' '}
            <span className="font-sans text-muted">({f.status})</span>
          </figcaption>
          {f.binary ? (
            <p className="p-2 text-xs text-muted">Binary file</p>
          ) : (
            <Hunks hunks={f.hunks} />
          )}
        </figure>
      ))}
      {patch.data.truncated && (
        <p className="text-xs text-muted">The patch was cut short to stay responsive.</p>
      )}
    </Section>
  );
}

function Hunks({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="overflow-x-auto font-mono text-xs leading-5">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-hover/60 px-2 text-muted">{h.header}</div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              className={clsx(
                'whitespace-pre px-2',
                l.kind === 'removed' && 'bg-side-left-soft',
                l.kind === 'added' && 'bg-side-right-soft',
              )}
            >
              {l.kind === 'removed' ? '−' : l.kind === 'added' ? '+' : ' '} {l.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
