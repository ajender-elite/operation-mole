import type { GitLogCommit, GitSource } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import type { JSX, SubmitEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { CommitRow } from '../components/commit-row.tsx';
import { ExploreHeader } from '../components/explore-header.tsx';
import { RefPicker } from '../components/ref-picker.tsx';
import { Loading, Notice } from '../components/notice.tsx';
import { gitLog } from '../lib/api.ts';
import { exploreLinks } from '../lib/explore-links.ts';
import { useRepoRefs } from '../lib/repo-refs.ts';
import { toSource } from '../lib/source-draft.ts';
import { isEditable } from '../lib/keys.ts';
import { loadPicks, savePicks, withPick } from '../lib/pick-tray.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { refSourceFromParams } from '../lib/sources.ts';
import { commitsUrl, seriesUrl, sessionPath } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';
import { CommitDetails } from './commit-page.tsx';

/** Commits per page; "Show more" asks for the next page. */
const PAGE = 50;

/**
 * The URL a legacy Commits link redirects to, or undefined when the link is not a legacy one. Range Log
 * (`top`, `bottom`) is the commits of `top` not in `bottom`; the old Commit List (`side=left|right`) is the
 * commits of that side's commit not in the other side's, for its repo.
 */
function legacyCommitsUrl(
  params: URLSearchParams,
  user: string,
  sessionId: string,
): string | undefined {
  const repo = params.get('repo') ?? '';
  const top = params.get('top') ?? '';
  const bottom = params.get('bottom') ?? '';
  if (repo !== '' && top !== '' && bottom !== '') {
    return commitsUrl(
      user,
      sessionId,
      { type: 'git', repoId: repo, branch: top },
      { notIn: { type: 'git', repoId: repo, branch: bottom } },
    );
  }
  const side = params.get('side');
  if (side === 'left' || side === 'right') {
    const other = side === 'left' ? 'right' : 'left';
    const repoId = params.get(`${side}Repo`) ?? repo;
    const commit = params.get(`${side}Commit`) ?? '';
    const otherCommit = params.get(`${other}Commit`) ?? '';
    if (repoId !== '' && commit !== '') {
      return commitsUrl(
        user,
        sessionId,
        { type: 'git', repoId, branch: commit },
        otherCommit === '' ? {} : { notIn: { type: 'git', repoId, branch: otherCommit } },
      );
    }
  }
  return undefined;
}

/**
 * The Commits tab: the commits reachable from a ref, newest first, with a pane for the selected one. Narrow
 * the list by message, author, path (following its renames) or a range (`notIn`). `j`/`k` walk the list.
 * It replaces the History tab, Range Log and the File Compare Commit List.
 */
export function CommitsPage(): JSX.Element {
  const [params] = useSearchParams();
  const { user, sessionId } = useSessionParams();
  const legacy = legacyCommitsUrl(params, user, sessionId);
  if (legacy !== undefined) return <Navigate to={legacy} replace />;
  const source = refSourceFromParams(params);
  if (source === undefined) {
    return (
      <Notice>
        This commits link is incomplete. Open it from a branch, the Code tab or a commit.
      </Notice>
    );
  }
  return (
    <CommitsList key={`${source.repoId}/${source.remote ?? ''}/${source.branch}`} source={source} />
  );
}

/** The History tab of a path, as it was: the same list, with the path set. */
export function LegacyHistoryRedirect(): JSX.Element {
  const [params] = useSearchParams();
  const { user, sessionId } = useSessionParams();
  const source = refSourceFromParams(params);
  if (source === undefined) return <Navigate to={sessionPath(user, sessionId)} replace />;
  return (
    <Navigate
      to={commitsUrl(user, sessionId, source, { path: params.get('path') ?? undefined })}
      replace
    />
  );
}

function CommitsList({ source }: { source: GitSource }): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const [params, setParams] = useSearchParams();
  const workspace = useWorkspace();
  const [pages, setPages] = useState(1);
  const [picks, setPicks] = useState(() => loadPicks(user, sessionId, source.repoId));
  const repo = session.data?.repos.find((r) => r.id === source.repoId);
  const refs = useRepoRefs(user, sessionId, source.repoId, repo !== undefined);

  const path = params.get('path') ?? '';
  const grep = params.get('q') ?? '';
  const author = params.get('author') ?? '';
  const isFollowing = params.get('follow') === '1' && path !== '';
  const isFirstParent = params.get('firstParent') === '1';
  const isTopoOrder = params.get('topo') === '1';
  const notInBranch = params.get('notIn') ?? '';
  const notInRemote = params.get('notInRemote') ?? '';
  const notIn: GitSource | undefined =
    notInBranch === ''
      ? undefined
      : {
          type: 'git',
          repoId: source.repoId,
          branch: notInBranch,
          ...(notInRemote === '' ? {} : { remote: notInRemote }),
        };
  const selected = params.get('commit') ?? '';

  const log = useQuery({
    queryKey: [
      'git-commits',
      user,
      sessionId,
      source.repoId,
      source.remote ?? '',
      source.branch,
      notIn?.branch ?? '',
      notIn?.remote ?? '',
      path,
      isFollowing,
      grep,
      author,
      isFirstParent,
      isTopoOrder,
      pages,
    ] as const,
    queryFn: ({ signal }) =>
      gitLog(
        {
          user,
          sessionId,
          source,
          limit: PAGE * pages,
          ...(notIn === undefined ? {} : { exclude: notIn }),
          ...(path === '' ? {} : { paths: [path] }),
          follow: isFollowing,
          firstParent: isFirstParent,
          topoOrder: isTopoOrder,
          ...(grep === '' ? {} : { grep }),
          ...(author === '' ? {} : { author }),
        },
        signal,
      ),
    enabled: repo !== undefined,
  });

  const commits: GitLogCommit[] = useMemo(() => log.data?.commits ?? [], [log.data]);
  const current = selected !== '' ? selected : (commits[0]?.sha ?? '');
  const select = (sha: string) => {
    const next = new URLSearchParams(params);
    next.set('commit', sha);
    setParams(next);
  };

  // j and k walk the list (the pane follows); both are ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      if (event.key !== 'j' && event.key !== 'k') return;
      const at = commits.findIndex((c) => c.sha === current);
      const to = event.key === 'j' ? Math.min(at + 1, commits.length - 1) : Math.max(at - 1, 0);
      const next = commits[to];
      if (next !== undefined && to !== at) {
        event.preventDefault();
        const updated = new URLSearchParams(params);
        updated.set('commit', next.sha);
        setParams(updated);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [commits, current, params, setParams]);

  if (session.isError) return <Notice tone="error">{session.error.message}</Notice>;
  if (session.isPending) return <Loading label="Loading session…" />;
  if (repo === undefined) return <Notice>This repository is no longer in the session.</Notice>;

  const remote = source.remote ?? repo.remotes[0]?.name ?? 'origin';
  const title =
    path === ''
      ? `Commits on ${source.branch}`
      : `Commits${isFollowing ? ' following' : ' touching'} ${path}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExploreHeader
        where={repo.name}
        picker={
          <RefPicker
            remotes={repo.remotes.map((r) => r.name)}
            refs={refs.data?.refs}
            isLoading={refs.isPending}
            current={{ remote, name: source.branch }}
            onOpen={(choice) => {
              const next = toSource({
                type: 'git',
                repoId: source.repoId,
                remote: choice.remote,
                branch: choice.name,
              });
              workspace.open(commitsUrl(user, sessionId, next));
            }}
          />
        }
        links={exploreLinks(user, sessionId, source, 'commits')}
        onOpen={(url) => {
          workspace.open(url);
        }}
      />
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <section aria-label="Commit list" className="flex min-h-0 flex-col border-line md:border-r">
          <CommitFilters
            key={`${path}|${grep}|${author}|${notInBranch}|${isFollowing}|${isFirstParent}|${isTopoOrder}`}
            path={path}
            grep={grep}
            author={author}
            follow={isFollowing}
            firstParent={isFirstParent}
            topoOrder={isTopoOrder}
            notInBranch={notInBranch}
            onApply={(next) => {
              const updated = new URLSearchParams(params);
              for (const [key, value] of Object.entries(next)) {
                if (value === undefined || value === '' || value === false) updated.delete(key);
                else updated.set(key, value === true ? '1' : value);
              }
              updated.delete('commit');
              setParams(updated);
            }}
          />
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
            <span className="truncate">{title}</span>
            <button
              type="button"
              className="touch-target rounded-md border border-line bg-accent-soft px-2 py-0.5 hover:bg-hover disabled:opacity-60"
              disabled={picks.length === 0}
              onClick={() => {
                workspace.open(seriesUrl(user, sessionId, source.repoId, picks), { isExact: true });
              }}
            >
              {picks.length > 0 ? `Open the series (${picks.length})` : 'No picks yet'}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {log.isError && <Notice tone="error">{log.error.message}</Notice>}
            {!log.data && !log.isError && <Loading label="Loading commits…" />}
            {log.data !== undefined && commits.length === 0 && <Notice>No commits match.</Notice>}
            {commits.length > 0 && (
              <ul aria-label={title} className="divide-y divide-line">
                {commits.map((commit) => {
                  const isPicked = picks.includes(commit.sha);
                  const isCurrent = commit.sha === current;
                  return (
                    <CommitRow
                      key={commit.sha}
                      commit={commit}
                      isCurrent={isCurrent}
                      isPicked={isPicked}
                      onSelect={() => {
                        select(commit.sha);
                      }}
                      onAddToSeries={() => {
                        const next = withPick(picks, commit.sha);
                        savePicks(user, sessionId, source.repoId, next);
                        setPicks(next);
                      }}
                    />
                  );
                })}
              </ul>
            )}
            {log.data?.hasMore === true && (
              <div className="flex justify-center p-3">
                <button
                  type="button"
                  className="touch-target rounded-md border border-line px-3 py-1.5 text-sm hover:bg-hover"
                  onClick={() => {
                    setPages((n) => n + 1);
                  }}
                >
                  Show more commits
                </button>
              </div>
            )}
          </div>
        </section>
        <section aria-label="Selected commit" className="min-h-0 overflow-auto">
          {current === '' ? (
            <Notice>Choose a commit to see its patch.</Notice>
          ) : (
            <CommitDetails key={current} repoId={source.repoId} sha={current} />
          )}
        </section>
      </div>
    </div>
  );
}

/** The narrowing controls of the list. Applied on submit, so the URL (and the list) changes once. */
function CommitFilters({
  path,
  grep,
  author,
  follow: isFollowingInUrl,
  firstParent: isFirstParentInUrl,
  topoOrder: isTopoOrderInUrl,
  notInBranch,
  onApply,
}: {
  path: string;
  grep: string;
  author: string;
  follow: boolean;
  firstParent: boolean;
  topoOrder: boolean;
  notInBranch: string;
  onApply: (next: {
    path?: string | undefined;
    q?: string | undefined;
    author?: string | undefined;
    follow?: boolean | undefined;
    firstParent?: boolean | undefined;
    topo?: boolean | undefined;
    notIn?: string | undefined;
  }) => void;
}): JSX.Element {
  const [draftGrep, setDraftGrep] = useState(grep);
  const [draftAuthor, setDraftAuthor] = useState(author);
  const [draftPath, setDraftPath] = useState(path);
  const [isFollowing, setFollowing] = useState(isFollowingInUrl);
  const [isFirstParent, setFirstParent] = useState(isFirstParentInUrl);
  const [isTopoOrder, setTopoOrder] = useState(isTopoOrderInUrl);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    onApply({
      path: draftPath.trim().replace(/^\/+|\/+$/g, '') || undefined,
      q: draftGrep.trim() || undefined,
      author: draftAuthor.trim() || undefined,
      follow: isFollowing && draftPath.trim() !== '',
      firstParent: isFirstParent,
      topo: isTopoOrder,
      notIn: notInBranch || undefined,
    });
  };
  return (
    <form
      aria-label="Filter commits"
      onSubmit={submit}
      className="flex flex-col gap-2 border-b border-line bg-surface p-3 text-sm"
    >
      <input
        aria-label="Message contains"
        placeholder="Message contains"
        value={draftGrep}
        onChange={(event) => {
          setDraftGrep(event.currentTarget.value);
        }}
        className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
      />
      <input
        aria-label="Author contains"
        placeholder="Author contains"
        value={draftAuthor}
        onChange={(event) => {
          setDraftAuthor(event.currentTarget.value);
        }}
        className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
      />
      <input
        aria-label="Only the folder or file"
        placeholder="Only this folder or file"
        value={draftPath}
        onChange={(event) => {
          setDraftPath(event.currentTarget.value);
        }}
        className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-sm"
      />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={isFollowing}
          disabled={draftPath.trim() === ''}
          onChange={(event) => {
            setFollowing(event.currentTarget.checked);
          }}
        />
        Follow renames (one file)
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={isFirstParent}
          onChange={(event) => {
            setFirstParent(event.currentTarget.checked);
          }}
        />
        First parent only
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={isTopoOrder}
          onChange={(event) => {
            setTopoOrder(event.currentTarget.checked);
          }}
        />
        Topological order
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="touch-target rounded-md border border-line px-2.5 py-1 hover:bg-hover"
        >
          Apply
        </button>
        {notInBranch !== '' && (
          <button
            type="button"
            className="touch-target rounded-md border border-line px-2.5 py-1 text-xs hover:bg-hover"
            onClick={() => {
              onApply({
                path: draftPath.trim() || undefined,
                q: draftGrep.trim() || undefined,
                author: draftAuthor.trim() || undefined,
                follow: isFollowing && draftPath.trim() !== '',
                notIn: undefined,
              });
            }}
          >
            Clear the range (not in {notInBranch})
          </button>
        )}
      </div>
    </form>
  );
}
