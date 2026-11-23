import type { CommitPatch, PatchFile, SnapshotFileDiff } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useSearchParams } from 'react-router';
import {
  SnapshotDiffView,
  type DiffLayout,
  type LineRef,
} from '../components/snapshot-diff-view.tsx';
import { commitPatch } from '../lib/api.ts';
import { shortSha } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { sourceLabel } from '../lib/sources.ts';

const statusText: Record<PatchFile['status'], string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  other: 'Changed',
};

/**
 * Commit tab: one commit's details and what it changes against its first parent. Each file is
 * shown the same way as a File Compare (side by side by default, or inline), without attribution:
 * the commit is the thing being shown here.
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
  const [layout, setLayout] = useState<DiffLayout>('side');

  const patch = useQuery({
    queryKey: ['commit-patch', user, sessionId, repoId, sha] as const,
    queryFn: ({ signal }) =>
      commitPatch(
        {
          user,
          sessionId,
          upstream: { type: 'git', repoId, branch: sha },
          commit: sha,
        },
        signal,
      ),
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
  const data = patch.data;
  const { details } = data;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-1 border-b border-line bg-surface px-4 py-3">
        <h1 className="flex items-start gap-2 text-base font-semibold">
          <GitCommitHorizontal className="mt-1 size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 break-words">{details.subject}</span>
        </h1>
        <p className="text-xs text-muted">
          <span className="font-mono text-ink">{shortSha(details.sha)}</span> · {details.authorName}{' '}
          · authored {formatDate(details.authorDate)}
          {details.committerName !== details.authorName || details.commitDate !== details.authorDate
            ? ` · committed by ${details.committerName} ${formatDate(details.commitDate)}`
            : ''}
        </p>
        <p className="text-xs text-muted">
          {details.parents.length === 0
            ? 'Root commit'
            : `Parent${details.parents.length === 1 ? '' : 's'}: ${details.parents
                .map((p) => shortSha(p))
                .join(', ')}`}
          {' · '}
          {sourceLabel({ type: 'git', repoId, branch: sha }, repos)}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {data.files.length === 0 && (
          <p className="p-6 text-center text-muted">This commit changes no files.</p>
        )}
        {data.files.map((file) => (
          <PatchFileSection
            key={`${file.oldPath ?? ''}\u0000${file.newPath ?? ''}`}
            file={file}
            patch={data}
            layout={layout}
            onLayoutChange={setLayout}
          />
        ))}
        {data.truncated && (
          <p className="border-t border-line p-3 text-center text-muted">
            This commit was cut short to stay responsive; some files or lines are not shown.
          </p>
        )}
      </div>
    </div>
  );
}

/** One changed file of the commit, with its own focus (so next/previous hunk works per file). */
function PatchFileSection({
  file,
  patch,
  layout,
  onLayoutChange,
}: {
  file: PatchFile;
  patch: CommitPatch;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
}) {
  const [focusedHunk, setFocusedHunk] = useState<number>();
  const [focusedLine, setFocusedLine] = useState<LineRef>();
  const path =
    file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== file.newPath
      ? `${file.oldPath} → ${file.newPath}`
      : (file.newPath ?? file.oldPath ?? '');
  // The commit's patch as a snapshot diff: Base is the first parent, Target the commit.
  const diff: SnapshotFileDiff = {
    leftCommit: patch.baseParent ?? '',
    rightCommit: patch.commit,
    ...(file.oldPath === undefined ? {} : { leftPath: file.oldPath }),
    ...(file.newPath === undefined ? {} : { rightPath: file.newPath }),
    content: file.binary ? 'binary' : 'text',
    hunks: file.hunks,
    commits: [],
  };
  const leftLabel =
    patch.baseParent === undefined ? 'nothing' : `parent (${shortSha(patch.baseParent)})`;
  const rightLabel = `commit (${shortSha(patch.commit)})`;
  return (
    <section aria-label={`File ${path}`} className="border-b border-line">
      <h2 className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-canvas px-4 py-1.5 font-mono text-sm">
        <span
          className={clsx(
            'rounded px-1.5 font-sans text-xs',
            file.status === 'added' && 'bg-right-soft text-right',
            file.status === 'deleted' && 'bg-left-soft text-left',
            file.status !== 'added' && file.status !== 'deleted' && 'bg-hover text-muted',
          )}
        >
          {statusText[file.status]}
        </span>
        <span className="min-w-0 truncate">{path}</span>
      </h2>
      {diff.content === 'binary' ? (
        <p className="p-4 text-muted">Binary file: there are no lines to show.</p>
      ) : diff.hunks.length === 0 ? (
        <p className="p-4 text-muted">
          No content changes (for example a mode change or a rename).
        </p>
      ) : (
        <div className="flex h-[60vh] min-h-64 flex-col">
          <SnapshotDiffView
            diff={diff}
            leftLabel={leftLabel}
            rightLabel={rightLabel}
            focusedHunk={focusedHunk}
            focusedLine={focusedLine}
            highlightCommit={undefined}
            layout={layout}
            onLayoutChange={onLayoutChange}
            onFocusHunk={setFocusedHunk}
            onFocusLine={setFocusedLine}
            onOpenCommit={() => undefined}
          />
        </div>
      )}
    </section>
  );
}
