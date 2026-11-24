import type { GitRefEntry, RepoInfo } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState, type JSX } from 'react';
import { useSearchParams } from 'react-router';
import { ExploreHeader } from '../components/explore-header.tsx';
import { Loading, Notice } from '../components/notice.tsx';
import { gitRefs } from '../lib/api.ts';
import { shortSha } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';
import { refMatches } from '../lib/ref-filter.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { betweenUrl, codeUrl, commitsUrl, seriesUrl } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';
import { exploreLinks } from '../lib/explore-links.ts';

/**
 * Branches tab: every branch and tag of every remote of one repo, grouped by remote. Each row says how far
 * the branch is ahead of and behind the repo's default branch, and opens its Code and History tabs.
 */
export function BranchesPage(): JSX.Element {
  const [params] = useSearchParams();
  const repoId = params.get('repo') ?? '';
  if (repoId === '') {
    return <Notice>This branches link is incomplete. Open it from the Overview.</Notice>;
  }
  return <BranchList key={repoId} repoId={repoId} />;
}

function BranchList({ repoId }: { repoId: string }): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const workspace = useWorkspace();
  const repo = session.data?.repos.find((r) => r.id === repoId);
  const [query, setQuery] = useState('');

  const refs = useQuery({
    queryKey: ['git-refs', user, sessionId, repoId, repo?.defaultBranch ?? ''] as const,
    queryFn: ({ signal }) =>
      gitRefs(
        {
          user,
          sessionId,
          repoId,
          ...(repo === undefined
            ? {}
            : { compareTo: { type: 'git', repoId, branch: repo.defaultBranch } }),
        },
        signal,
      ),
    enabled: repo !== undefined,
  });

  if (session.isError) return <Notice tone="error">{session.error.message}</Notice>;
  if (session.isPending) return <Loading label="Loading session…" />;
  if (repo === undefined) return <Notice>This repository is no longer in the session.</Notice>;

  const groups = groupByRemote((refs.data?.refs ?? []).filter((entry) => refMatches(entry, query)));
  const source = { type: 'git' as const, repoId, branch: repo.defaultBranch };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExploreHeader
        where={`${repo.name} · ${repo.defaultBranch} (default)`}
        links={exploreLinks(user, sessionId, source, 'branches')}
        onOpen={(url) => {
          workspace.open(url);
        }}
      />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
        <input
          type="search"
          aria-label="Filter branches and tags"
          placeholder="Filter by name"
          value={query}
          className="w-full max-w-sm rounded-md border border-line bg-canvas px-2.5 py-1.5 text-sm text-ink"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        {refs.isError && <Notice tone="error">{refs.error.message}</Notice>}
        {!refs.data && !refs.isError && <Loading label="Loading branches…" />}
        {groups.map(([remote, entries]) => (
          <RemoteSection
            key={remote}
            remote={remote}
            repo={repo}
            entries={entries}
            onOpen={(url) => {
              workspace.open(url);
            }}
          />
        ))}
        {refs.data && groups.length === 0 && query.trim() !== '' && (
          <Notice>{`No branch or tag matches “${query.trim()}”.`}</Notice>
        )}
        {refs.data && groups.length === 0 && query.trim() === '' && (
          <Notice>No branches or tags yet. Fetch the repo.</Notice>
        )}
        <p className="text-xs text-muted">
          Ahead and behind count commits against {repo.defaultBranch} on the same remote.
        </p>
      </div>
    </div>
  );
}

function RemoteSection({
  remote,
  repo,
  entries,
  onOpen,
}: {
  remote: string;
  repo: RepoInfo;
  entries: GitRefEntry[];
  onOpen: (url: string) => void;
}): JSX.Element {
  const { user, sessionId } = useSessionParams();
  return (
    <section aria-label={`Branches of ${remote}`} className="space-y-2">
      <h2 className="text-sm font-semibold">
        {remote} <span className="font-normal text-muted">{repoRemoteUrl(repo, remote)}</span>
      </h2>
      <ul className="divide-y divide-line rounded-md border border-line bg-surface">
        {entries.map((entry) => {
          const ref = { type: 'git' as const, repoId: repo.id, remote, branch: entry.name };
          return (
            <li
              key={`${entry.kind}:${entry.name}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-sm">
                  <span
                    className={clsx(
                      'rounded px-1 text-[11px] uppercase',
                      entry.kind === 'tag' ? 'bg-hover text-muted' : 'bg-accent-soft text-ink',
                    )}
                  >
                    {entry.kind}
                  </span>
                  <span className="truncate font-medium">{entry.name}</span>
                </span>
                <span className="truncate text-xs text-muted">
                  <span className="font-mono">{shortSha(entry.commit)}</span> {entry.subject} ·{' '}
                  {formatDate(entry.commitDate)}
                </span>
              </div>
              {entry.ahead !== undefined && entry.behind !== undefined && (
                <span
                  className="font-mono text-xs text-muted"
                  aria-label="Ahead and behind the default branch"
                >
                  ↑{entry.ahead} ↓{entry.behind}
                </span>
              )}
              <div className="flex gap-1">
                <button
                  type="button"
                  className="touch-target rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
                  onClick={() => {
                    onOpen(codeUrl(user, sessionId, ref));
                  }}
                >
                  Code
                </button>
                <button
                  type="button"
                  className="touch-target rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
                  onClick={() => {
                    onOpen(commitsUrl(user, sessionId, ref));
                  }}
                >
                  History
                </button>
                <button
                  type="button"
                  className="touch-target rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
                  onClick={() => {
                    onOpen(
                      seriesUrl(user, sessionId, repo.id, [], [{ remote, branch: entry.name }]),
                    );
                  }}
                >
                  Check picks here
                </button>
                <button
                  type="button"
                  className="touch-target rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
                  onClick={() => {
                    onOpen(
                      betweenUrl(
                        user,
                        sessionId,
                        repo.id,
                        { remote, branch: entry.name },
                        { remote: repo.remotes[0]?.name ?? 'origin', branch: repo.defaultBranch },
                      ),
                    );
                  }}
                >
                  Compare with {repo.defaultBranch}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The refs grouped by remote, remotes in the order the server sent them (origin first). */
function groupByRemote(refs: GitRefEntry[]): Array<[string, GitRefEntry[]]> {
  const groups = new Map<string, GitRefEntry[]>();
  for (const ref of refs) {
    const list = groups.get(ref.remote) ?? [];
    list.push(ref);
    groups.set(ref.remote, list);
  }
  return [...groups.entries()];
}

function repoRemoteUrl(repo: RepoInfo, remote: string): string {
  return repo.remotes.find((r) => r.name === remote)?.url ?? '';
}
