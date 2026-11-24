import type { CommitPatch, PatchFile, SnapshotFileDiff } from '@om/shared';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type JSX } from 'react';
import { shortSha } from '../lib/attribution.ts';
import {
  COLLAPSE_AFTER,
  fileAnchor,
  countLines,
  patchPath,
  statusText,
} from '../lib/commit-patch.ts';
import { SnapshotDiffView, type DiffLayout, type LineRef } from './snapshot-diff-view.tsx';

/**
 * Every changed file of a commit, one section each, in the caller's scroll container. Each section
 * is a file's diff against the first parent; no attribution, since the commit is the point.
 */
export function CommitFiles({
  patch,
  layout,
  onLayoutChange,
  filter,
  anchorPrefix = 'commit',
}: {
  patch: CommitPatch;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
  /** Only files whose path contains this text (case-insensitive). */
  filter?: string | undefined;
  /** Prefix for the section ids (see {@link fileAnchor}). */
  anchorPrefix?: string;
}): JSX.Element {
  const needle = (filter ?? '').trim().toLowerCase();
  const shown = patch.files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => needle === '' || patchPath(file).toLowerCase().includes(needle));
  if (patch.files.length === 0) {
    return <p className="p-6 text-center text-muted">This commit changes no files.</p>;
  }
  const isCollapsedByDefault = patch.files.length > COLLAPSE_AFTER;
  return (
    <div>
      {shown.length === 0 && (
        <p className="p-6 text-center text-muted">No changed file matches “{filter}”.</p>
      )}
      {shown.map(({ file, index }) => (
        <PatchFileSection
          key={`${file.oldPath ?? ''}\u0000${file.newPath ?? ''}`}
          id={fileAnchor(anchorPrefix, index)}
          file={file}
          patch={patch}
          layout={layout}
          onLayoutChange={onLayoutChange}
          initiallyCollapsed={isCollapsedByDefault}
        />
      ))}
      {patch.truncated && (
        <p className="border-t border-line p-3 text-center text-muted">
          This commit was cut short to stay responsive; some files or lines are not shown.
        </p>
      )}
    </div>
  );
}

/** One changed file of the commit: a heading you can collapse, then its diff with its own focus. */
export function PatchFileSection({
  id,
  file,
  patch,
  layout,
  onLayoutChange,
  initiallyCollapsed = false,
}: {
  id?: string;
  file: PatchFile;
  patch: CommitPatch;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
  initiallyCollapsed?: boolean;
}): JSX.Element {
  const [isCollapsed, setCollapsed] = useState(initiallyCollapsed);
  const [focusedHunk, setFocusedHunk] = useState<number>();
  const [focusedLine, setFocusedLine] = useState<LineRef>();
  const path = patchPath(file);
  // The commit's patch as a snapshot diff: Left is the first parent, Right the commit.
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
  const counts = countLines(file);
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;
  return (
    <section id={id} aria-label={`File ${path}`} className="scroll-mt-20 border-b border-line">
      <h2 className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-canvas px-2 py-1.5 font-mono text-sm">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${path}`}
          className="touch-target shrink-0 rounded p-0.5 hover:bg-hover"
          onClick={() => {
            setCollapsed((value) => !value);
          }}
        >
          <Chevron className="size-4" aria-hidden />
        </button>
        <span
          className={clsx(
            'rounded px-1.5 font-sans text-xs',
            file.status === 'added' && 'bg-side-right-soft text-side-right',
            file.status === 'deleted' && 'bg-side-left-soft text-side-left',
            file.status !== 'added' && file.status !== 'deleted' && 'bg-hover text-muted',
          )}
        >
          {statusText[file.status]}
        </span>
        <span className="min-w-0 truncate">{path}</span>
        <span className="ml-auto shrink-0 font-sans text-xs tabular-nums">
          <span className="text-side-right">+{counts.additions}</span>{' '}
          <span className="text-side-left">−{counts.deletions}</span>
        </span>
      </h2>
      {!isCollapsed &&
        (diff.content === 'binary' ? (
          <p className="p-4 text-muted">Binary file: there are no lines to show.</p>
        ) : diff.hunks.length === 0 ? (
          <p className="p-4 text-muted">
            No content changes (for example a mode change or a rename).
          </p>
        ) : (
          <div className="flex flex-col">
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
        ))}
    </section>
  );
}
