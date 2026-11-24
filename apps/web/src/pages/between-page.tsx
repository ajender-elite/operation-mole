import type { GitPatchEquivalent, GitRefEntry, GitSource } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { JSX } from 'react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CommitRow } from '../components/commit-row.tsx';
import { ExploreHeader } from '../components/explore-header.tsx';
import { Loading, Notice } from '../components/notice.tsx';
import { gitPatchEquivalents, gitRefs } from '../lib/api.ts';
import { loadPicks, savePicks, withPick } from '../lib/pick-tray.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { commitUrl, seriesUrl, type RemoteRef } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/** Commits per comparison; the newest are shown, and the rest are said to exist. */
const LIMIT = 200;

/** `remote/branch` as the URL writes a side of the comparison; undefined when it is not that. */
function parseRemoteRef(value: string | null): RemoteRef | undefined {
  if (value === null) return undefined;
  const at = value.indexOf('/');
  if (at <= 0 || at === value.length - 1) return undefined;
  return { remote: value.slice(0, at), branch: value.slice(at + 1) };
}

/** The mark a commit carries, in the words the page uses for it. */
const MARK_TEXT: Record<GitPatchEquivalent['mark'], string> = {
  left: 'Only on the left',
  right: 'Only on the right',
  equivalent: 'Picked across',
};

/**
 * Between tab: the commits on each side of two branches (`left...right`), newest first, each marked as
 * only on one side, or as already picked across (the same change on the other side). The usual question
 * is what the left has that the right lacks: "Add all only on the left" puts those into the series.
 */
export function BetweenPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const { user, sessionId } = useSessionParams();
  const repoId = params.get('repo') ?? '';
  const left = parseRemoteRef(params.get('left'));
  const right = parseRemoteRef(params.get('right'));
  const session = useSessionDetail(user, sessionId);
  const repo = session.data?.repos.find((r) => r.id === repoId);
  const refs = useQuery({
    queryKey: ['git-refs', user, sessionId, repoId, 'between'] as const,
    queryFn: ({ signal }) => gitRefs({ user, sessionId, repoId }, signal),
    enabled: repo !== undefined,
  });

  if (session.isError) return <Notice tone="error">{session.error.message}</Notice>;
  if (session.isPending) return <Loading label="Loading session…" />;
  if (repo === undefined) return <Notice>This repository is no longer in the session.</Notice>;
  if (left === undefined || right === undefined) {
    return (
      <Notice>
        This comparison link is incomplete. Open it from the Overview or a branch list.
      </Notice>
    );
  }

  const refList = refs.data?.refs ?? [];
  const choose = (side: 'left' | 'right', value: string) => {
    const next = new URLSearchParams(params);
    next.set(side, value);
    setParams(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExploreHeader
        where={`${repo.name} · ${left.remote}/${left.branch} … ${right.remote}/${right.branch}`}
        links={[]}
        onOpen={() => undefined}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <BranchChoice
            label="Left branch"
            value={`${left.remote}/${left.branch}`}
            refs={refList}
            onChange={(value) => {
              choose('left', value);
            }}
          />
          <BranchChoice
            label="Right branch"
            value={`${right.remote}/${right.branch}`}
            refs={refList}
            onChange={(value) => {
              choose('right', value);
            }}
          />
        </div>
        <Comparison
          key={`${left.remote}/${left.branch}…${right.remote}/${right.branch}`}
          repoId={repoId}
          left={left}
          right={right}
          repoName={repo.name}
        />
      </div>
    </div>
  );
}

function BranchChoice({
  label,
  value,
  refs,
  onChange,
}: {
  label: string;
  value: string;
  refs: GitRefEntry[];
  onChange: (value: string) => void;
}): JSX.Element {
  // A side the URL names but the list does not hold yet (a branch just fetched) still shows as chosen.
  const isListed = refs.some((r) => `${r.remote}/${r.name}` === value);
  return (
    <label className="flex min-w-56 flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        className="rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm"
      >
        {!isListed && <option value={value}>{value}</option>}
        {refs.map((ref) => (
          <option key={`${ref.kind}:${ref.remote}/${ref.name}`} value={`${ref.remote}/${ref.name}`}>
            {ref.remote}/{ref.name}
          </option>
        ))}
      </select>
    </label>
  );
}

type Filter = 'all' | GitPatchEquivalent['mark'];

function Comparison({
  repoId,
  left,
  right,
  repoName,
}: {
  repoId: string;
  left: RemoteRef;
  right: RemoteRef;
  repoName: string;
}): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const workspace = useWorkspace();
  const [filter, setFilter] = useState<Filter>('all');
  const [picks, setPicks] = useState(() => loadPicks(user, sessionId, repoId));
  const source = (ref: RemoteRef): GitSource => ({ type: 'git', repoId, ...ref });

  const result = useQuery({
    queryKey: ['git-between', user, sessionId, repoId, left, right] as const,
    queryFn: ({ signal }) =>
      gitPatchEquivalents(
        { user, sessionId, left: source(left), right: source(right), limit: LIMIT },
        signal,
      ),
  });

  if (result.isError) return <Notice tone="error">{result.error.message}</Notice>;
  if (!result.data) return <Loading label="Comparing…" />;

  const all = result.data.commits;
  const shown = filter === 'all' ? all : all.filter((c) => c.mark === filter);
  const onLeft = all.filter((c) => c.mark === 'left').map((c) => c.commit.sha);
  const count = (mark: Filter) =>
    mark === 'all' ? all.length : all.filter((c) => c.mark === mark).length;
  const addAll = (shas: readonly string[]) => {
    const next = shas.reduce((list, sha) => withPick(list, sha), picks);
    savePicks(user, sessionId, repoId, next);
    setPicks(next);
  };

  return (
    <section aria-label="Commits between the branches" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'left', 'right', 'equivalent'] as const).map((mark) => (
          <button
            key={mark}
            type="button"
            aria-pressed={filter === mark}
            className={clsx(
              'touch-target rounded-md border border-line px-2.5 py-1 text-sm',
              filter === mark ? 'bg-accent-soft font-medium' : 'text-muted hover:bg-hover',
            )}
            onClick={() => {
              setFilter(mark);
            }}
          >
            {mark === 'all' ? 'All' : MARK_TEXT[mark]} · {count(mark)}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            disabled={onLeft.length === 0}
            className="touch-target rounded-md border border-line px-2.5 py-1 text-sm hover:bg-hover disabled:opacity-50"
            onClick={() => {
              addAll(onLeft);
            }}
          >
            Add all only on the left to the series
          </button>
          {picks.length > 0 && (
            <button
              type="button"
              className="touch-target rounded-md border border-line bg-accent-soft px-2.5 py-1 text-sm hover:bg-hover"
              onClick={() => {
                workspace.open(seriesUrl(user, sessionId, repoId, picks), { isExact: true });
              }}
            >
              Open the series ({picks.length})
            </button>
          )}
        </div>
      </div>
      {result.data.truncated === true && (
        <p className="text-xs text-muted">Showing the newest {LIMIT} commits on each side.</p>
      )}
      {shown.length === 0 ? (
        <Notice>
          {all.length === 0
            ? `Nothing to compare: ${left.branch} and ${right.branch} hold the same commits.`
            : 'No commits with this mark.'}
        </Notice>
      ) : (
        <ul
          aria-label={`Commits in ${repoName}`}
          className="divide-y divide-line rounded-md border border-line bg-surface"
        >
          {shown.map(({ commit, mark }) => {
            const isPicked = picks.includes(commit.sha);
            return (
              <CommitRow
                key={commit.sha}
                commit={commit}
                badge={
                  <span
                    className={clsx(
                      'rounded px-1.5 py-0.5',
                      mark === 'equivalent' ? 'bg-hover text-muted' : 'bg-accent-soft text-ink',
                    )}
                  >
                    {MARK_TEXT[mark]}
                  </span>
                }
                isPicked={isPicked}
                onSelect={() => {
                  workspace.open(commitUrl(user, sessionId, repoId, commit.sha));
                }}
                onAddToSeries={() => {
                  addAll([commit.sha]);
                }}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
