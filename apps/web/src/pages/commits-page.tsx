import type { CommitInfo, GitSource, UpstreamCommitList } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { summarizeAttribution, shortSha, type CommitShare } from '../lib/attribution.ts';
import { upstreamCommits } from '../lib/api.ts';
import { formatDate } from '../lib/dates.ts';
import { fileDiffQuery, type SnapshotPair } from '../lib/snapshot-diff.ts';
import { sourceFromParams, sourceLabel, type Side } from '../lib/sources.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { commitUrl, fileUrl, type FileCompareTarget } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/** How many commits each list shows at most. */
const LIMIT = 50;

const value = (params: URLSearchParams, name: string): string | undefined => {
  const v = params.get(name);
  return v === null || v === '' ? undefined : v;
};

/** The pinned File Compare this list belongs to, and which side (Base or Target) it lists. */
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

/**
 * Commit List: one side of a File Compare, in its own tab, as three separate questions:
 * what makes this side diverge, which of those commits touched this file, and which commits
 * account for the changes the File Compare shows (or the focused hunk of them). Each is
 * computed by the server or from its attribution; this page only arranges them.
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
  const pinnedLeft: GitSource = { ...left, branch: leftCommit };
  const pinnedRight: GitSource = { ...right, branch: rightCommit };
  const mine = side === 'left' ? pinnedLeft : pinnedRight;
  const other = side === 'left' ? pinnedRight : pinnedLeft;
  const sidePath = side === 'left' ? target.leftPath : target.rightPath;
  const sideLabel = side === 'left' ? 'Base' : 'Target';

  const divergence = useQuery({
    queryKey: ['commit-list', user, sessionId, mine, other, null] as const,
    queryFn: ({ signal }) =>
      upstreamCommits(
        { user, sessionId, upstream: mine, downstream: other, limit: LIMIT, hideReachable: true },
        signal,
      ),
    staleTime: Infinity,
  });
  const touching = useQuery({
    queryKey: ['commit-list', user, sessionId, mine, other, sidePath ?? null] as const,
    queryFn: ({ signal }): Promise<UpstreamCommitList> =>
      upstreamCommits(
        {
          user,
          sessionId,
          upstream: mine,
          downstream: other,
          limit: LIMIT,
          hideReachable: true,
          ...(sidePath === undefined ? {} : { paths: [sidePath] }),
        },
        signal,
      ),
    enabled: sidePath !== undefined,
    staleTime: Infinity,
  });

  const pair: SnapshotPair = { user, sessionId, left: pinnedLeft, right: pinnedRight };
  const visible = useQuery(fileDiffQuery(pair, target, false, true));
  const visibleShares: CommitShare[] = (() => {
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

  const openCommit = (sha: string) => {
    workspace.open(commitUrl(user, sessionId, mine.repoId, sha));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-1.5 text-sm">
        <button
          type="button"
          title="Back to the File Compare, as you left it"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-hover"
          onClick={() => {
            workspace.open(
              fileUrl(
                user,
                sessionId,
                { left, right, leftCommit, rightCommit, target },
                { hunk: hunk === undefined ? undefined : String(hunk) },
              ),
            );
          }}
        >
          <ArrowLeft className="size-4" aria-hidden /> File compare
        </button>
        <h1 className="min-w-0 truncate font-medium">
          <span className="text-muted">{sideLabel} commits · </span>
          <span className="font-mono">{sourceLabel(mine, repos)}</span>
        </h1>
        <span className="ml-auto font-mono text-xs text-muted">{target.key}</span>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4 text-sm">
        <Group
          title="Accounting for the changes shown"
          hint={
            hunk === undefined
              ? `Commits that account for ${sideLabel} lines in this file, by git blame on the ${sideLabel} side.`
              : `Only the focused hunk (${hunk + 1}).`
          }
          isLoading={visible.isPending}
          error={visible.error?.message}
          isEmpty={visibleShares.length === 0}
          empty="No commits account for this side's lines in this file."
        >
          {visibleShares.map((s) => (
            <CommitRow
              key={s.commit.sha}
              commit={s.commit}
              detail={`${s.leftLines + s.rightLines} line${s.leftLines + s.rightLines === 1 ? '' : 's'} · ${s.hunks} hunk${s.hunks === 1 ? '' : 's'}`}
              onOpen={openCommit}
            />
          ))}
        </Group>

        <Group
          title={sidePath === undefined ? 'Touching this file' : `Touching ${sidePath}`}
          hint={
            sidePath === undefined
              ? `This file does not exist on the ${sideLabel} side, so no ${sideLabel} commit touches it.`
              : `Diverging ${sideLabel} commits that changed this file on the ${sideLabel} side.`
          }
          isLoading={sidePath !== undefined && touching.isPending}
          error={touching.error?.message}
          isEmpty={sidePath !== undefined && touching.data?.commits.length === 0}
          empty="No diverging commit changed this file."
          hasMore={touching.data?.hasMore}
        >
          {touching.data?.commits.map((c) => (
            <CommitRow key={c.sha} commit={c} onOpen={openCommit} />
          ))}
        </Group>

        <Group
          title={`All diverging commits on ${sideLabel}`}
          hint={`Commits in ${sideLabel}'s history that ${sideLabel === 'Base' ? 'Target' : 'Base'} does not contain. Not the same as the cause of the differences.`}
          isLoading={divergence.isPending}
          error={divergence.error?.message}
          isEmpty={divergence.data?.commits.length === 0}
          empty="Nothing on this side is missing from the other."
          hasMore={divergence.data?.hasMore}
        >
          {divergence.data?.commits.map((c) => (
            <CommitRow key={c.sha} commit={c} onOpen={openCommit} />
          ))}
        </Group>
      </div>
    </div>
  );
}

function Group({
  title,
  hint,
  isLoading,
  error,
  isEmpty,
  empty,
  hasMore,
  children,
}: {
  title: string;
  hint: string;
  isLoading: boolean;
  error: string | undefined;
  isEmpty: boolean | undefined;
  empty: string;
  hasMore?: boolean | undefined;
  children: JSX.Element[] | JSX.Element | undefined;
}): JSX.Element {
  return (
    <section aria-label={title} className="space-y-2">
      <header>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-muted">{hint}</p>
      </header>
      {error !== undefined ? (
        <p role="alert" className="rounded-md bg-error-soft p-2 text-error">
          {error}
        </p>
      ) : isLoading ? (
        <p className="flex items-center gap-2 text-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading…
        </p>
      ) : isEmpty === true ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">{children}</ul>
      )}
      {hasMore === true && (
        <p className="text-xs text-muted">Showing the newest {LIMIT}; there are more.</p>
      )}
    </section>
  );
}

/** One commit: opens its Commit tab. */
function CommitRow({
  commit,
  detail,
  onOpen,
}: {
  commit: CommitInfo;
  detail?: string;
  onOpen: (sha: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-hover"
        title={`${commit.sha}\nOpen this commit in a new tab`}
        onClick={() => {
          onOpen(commit.sha);
        }}
      >
        <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{commit.subject}</span>
          <span className="block text-xs text-muted">
            <span className="font-mono">{shortSha(commit.sha)}</span> · {commit.authorName} ·{' '}
            {formatDate(commit.authorDate)}
            {detail === undefined ? '' : ` · ${detail}`}
          </span>
        </span>
      </button>
    </li>
  );
}
