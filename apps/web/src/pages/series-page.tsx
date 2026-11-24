import type { GitCherryPick, GitRefEntry, GitSource } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { JSX, SubmitEvent } from 'react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ExploreHeader } from '../components/explore-header.tsx';
import { Loading, Notice } from '../components/notice.tsx';
import { gitCherryPick, gitRefs } from '../lib/api.ts';
import { shortSha } from '../lib/attribution.ts';
import { exploreLinks } from '../lib/explore-links.ts';
import { loadPicks, savePicks } from '../lib/pick-tray.ts';
import { usePooledQueries } from '../lib/pooled-queries.ts';
import { SeriesVerdict } from '../components/series-verdict.tsx';
import { CHECKS_AT_ONCE } from '../lib/series-checks.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The Series tab: a list of commits to pick, checked in order on the branches the user chooses. */
export function SeriesPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const { user, sessionId } = useSessionParams();
  const repoId = params.get('repo') ?? '';
  if (repoId === '') {
    return <Notice>This series link is incomplete. Open it from a commit or a branch.</Notice>;
  }
  // Without picks in the URL, the tab opens with the commits collected in this browser tab (the tray).
  const urlPicks = params.get('picks');
  const picks =
    urlPicks === null
      ? loadPicks(user, sessionId, repoId)
      : urlPicks.split(',').filter((p) => p !== '');
  const onto = params.getAll('onto').flatMap((value) => {
    const at = value.indexOf('/');
    return at <= 0 || at === value.length - 1
      ? []
      : [{ remote: value.slice(0, at), branch: value.slice(at + 1) }];
  });
  const write = (next: { picks?: string[]; onto?: Array<{ remote: string; branch: string }> }) => {
    const nextPicks = next.picks ?? picks;
    const nextOnto = next.onto ?? onto;
    savePicks(user, sessionId, repoId, nextPicks);
    setParams(new URLSearchParams(seriesQuery(repoId, nextPicks, nextOnto)));
  };
  return <SeriesEditor key={repoId} repoId={repoId} picks={picks} onto={onto} onChange={write} />;
}

/** The query string of a series: its repo, its picks in order, and the branches it is checked on. */
function seriesQuery(
  repoId: string,
  picks: readonly string[],
  onto: ReadonlyArray<{ remote: string; branch: string }>,
): URLSearchParams {
  const params = new URLSearchParams({ repo: repoId });
  if (picks.length > 0) params.set('picks', picks.join(','));
  for (const target of onto) params.append('onto', `${target.remote}/${target.branch}`);
  return params;
}

function SeriesEditor({
  repoId,
  picks,
  onto,
  onChange,
}: {
  repoId: string;
  picks: string[];
  onto: Array<{ remote: string; branch: string }>;
  onChange: (next: { picks?: string[]; onto?: Array<{ remote: string; branch: string }> }) => void;
}): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const workspace = useWorkspace();
  const repo = session.data?.repos.find((r) => r.id === repoId);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | undefined>(undefined);

  const refs = useQuery({
    queryKey: ['git-refs', user, sessionId, repoId, 'targets'] as const,
    queryFn: ({ signal }) => gitRefs({ user, sessionId, repoId }, signal),
    enabled: repo !== undefined,
  });

  // One check per branch, at most CHECKS_AT_ONCE running; each result is cached, so a revisit is instant.
  const checks = usePooledQueries<GitCherryPick>(
    onto.map((target) => ({
      id: `${target.remote}/${target.branch}`,
      queryKey: ['git-cherry-pick', user, sessionId, repoId, target.remote, target.branch, picks],
      run: (client) =>
        client.query({
          queryKey: [
            'git-cherry-pick',
            user,
            sessionId,
            repoId,
            target.remote,
            target.branch,
            picks,
          ],
          queryFn: ({ signal }) =>
            gitCherryPick(
              {
                user,
                sessionId,
                onto: { type: 'git', repoId, remote: target.remote, branch: target.branch },
                commits: picks,
              },
              signal,
            ),
          staleTime: Infinity,
        }),
    })),
    picks.length > 0,
    CHECKS_AT_ONCE,
  );

  if (session.isError) return <Notice tone="error">{session.error.message}</Notice>;
  if (session.isPending) return <Loading label="Loading session…" />;
  if (repo === undefined) return <Notice>This repository is no longer in the session.</Notice>;

  const source: GitSource = { type: 'git', repoId, branch: repo.defaultBranch };
  const isChosen = (ref: GitRefEntry) =>
    onto.some((t) => t.remote === ref.remote && t.branch === ref.name);
  const toggleTarget = (ref: GitRefEntry) => {
    const next = isChosen(ref)
      ? onto.filter((t) => !(t.remote === ref.remote && t.branch === ref.name))
      : [...onto, { remote: ref.remote, branch: ref.name }];
    onChange({ onto: next });
  };
  const addPick = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sha = draft.trim().toLowerCase();
    if (!FULL_SHA.test(sha)) {
      setDraftError('Paste the full 40-character commit id.');
      return;
    }
    if (picks.includes(sha)) {
      setDraftError('That commit is already in the series.');
      return;
    }
    setDraftError(undefined);
    setDraft('');
    onChange({ picks: [...picks, sha] });
  };
  const move = (index: number, by: number) => {
    const next = [...picks];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(index + by, 0, item);
    onChange({ picks: next });
  };
  const remove = (index: number) => {
    onChange({ picks: picks.filter((_, i) => i !== index) });
  };

  const refList = (refs.data?.refs ?? []).filter((r) => r.kind === 'branch');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExploreHeader
        where={`${repo.name} · series`}
        links={exploreLinks(user, sessionId, source, 'series')}
        onOpen={(url) => {
          workspace.open(url);
        }}
      />
      <div className="grid min-h-0 flex-1 gap-4 overflow-auto p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section aria-label="Picks" className="space-y-3">
          <h2 className="text-sm font-semibold">Commits to pick, in order</h2>
          {picks.length === 0 ? (
            <p className="text-sm text-muted">
              Add the commits to check, oldest first, as git cherry-pick would take them.
            </p>
          ) : (
            <ol className="divide-y divide-line rounded-md border border-line bg-surface">
              {picks.map((sha, index) => (
                <li key={sha} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="w-6 text-right text-muted">{index + 1}</span>
                  <span className="font-mono">{shortSha(sha)}</span>
                  <span className="ml-auto flex gap-1">
                    <button
                      type="button"
                      aria-label={`Move ${shortSha(sha)} up`}
                      disabled={index === 0}
                      className="touch-target rounded p-1 hover:bg-hover disabled:opacity-40"
                      onClick={() => {
                        move(index, -1);
                      }}
                    >
                      <ArrowUp className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${shortSha(sha)} down`}
                      disabled={index === picks.length - 1}
                      className="touch-target rounded p-1 hover:bg-hover disabled:opacity-40"
                      onClick={() => {
                        move(index, 1);
                      }}
                    >
                      <ArrowDown className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${shortSha(sha)}`}
                      className="touch-target rounded p-1 hover:bg-hover"
                      onClick={() => {
                        remove(index);
                      }}
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <form onSubmit={addPick} className="flex flex-wrap items-start gap-2">
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
              <span className="text-muted">Commit id to add</span>
              <input
                value={draft}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                }}
                aria-invalid={draftError !== undefined}
                aria-describedby={draftError === undefined ? undefined : 'pick-error'}
                placeholder="40-character commit id"
                className="rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm"
              />
            </label>
            <button
              type="submit"
              className="touch-target mt-5 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-hover"
            >
              Add to series
            </button>
            {draftError !== undefined && (
              <p id="pick-error" role="alert" className="basis-full text-xs text-error">
                {draftError}
              </p>
            )}
          </form>

          <h2 className="pt-2 text-sm font-semibold">Check on branches</h2>
          {refs.isError && <Notice tone="error">{refs.error.message}</Notice>}
          <ul className="max-h-72 space-y-1 overflow-auto rounded-md border border-line bg-surface p-2">
            {refList.map((ref) => (
              <li key={`${ref.remote}/${ref.name}`}>
                <label className="flex items-center gap-2 px-1 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    checked={isChosen(ref)}
                    onChange={() => {
                      toggleTarget(ref);
                    }}
                  />
                  <span className="text-muted">{ref.remote}/</span>
                  <span className="truncate">{ref.name}</span>
                </label>
              </li>
            ))}
            {refs.data && refList.length === 0 && (
              <li className="px-1 text-sm text-muted">No branches yet. Fetch the repo.</li>
            )}
          </ul>
        </section>

        <section aria-label="Results" className="space-y-4">
          {picks.length === 0 && (
            <p className="text-sm text-muted">
              Add commits to see whether they apply, branch by branch.
            </p>
          )}
          {picks.length > 0 && onto.length === 0 && (
            <p className="text-sm text-muted">Choose the branches to check the commits on.</p>
          )}
          {picks.length > 0 &&
            onto.map((target) => {
              const id = `${target.remote}/${target.branch}`;
              const data = checks.results.find((r) => r.id === id)?.data;
              const error = checks.errors.find((r) => r.id === id)?.message;
              return (
                <SeriesVerdict
                  key={id}
                  heading={id}
                  data={data}
                  error={error}
                  isPending={data === undefined && error === undefined}
                />
              );
            })}
        </section>
      </div>
    </div>
  );
}
