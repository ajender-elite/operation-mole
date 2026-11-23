import type { DiffLine, DivergenceCommit, SnapshotFileDiff } from '@om/shared';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, Columns2, Rows3 } from 'lucide-react';
import { useEffect, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { commitPlacement, shortSha } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';
import { alignRows } from '../lib/diff-rows.ts';

/** A changed line, by hunk index and line index within the hunk. */
export type LineRef = { hunk: number; line: number };

/** `left` is Base, `right` is Target. */
export type Side = 'left' | 'right';

/** `side`: Base and Target next to each other (the default). `inline`: one list with +/- lines. */
export type DiffLayout = 'side' | 'inline';

type SnapshotDiffViewProps = {
  diff: SnapshotFileDiff;
  leftLabel: string;
  rightLabel: string;
  focusedHunk: number | undefined;
  focusedLine: LineRef | undefined;
  /** Commit whose lines are emphasized (others dimmed). */
  highlightCommit: string | undefined;
  /** Undefined means the default, side by side. */
  layout?: DiffLayout | undefined;
  onLayoutChange?: ((layout: DiffLayout) => void) | undefined;
  onFocusHunk: (hunk: number) => void;
  onFocusLine: (line: LineRef | undefined) => void;
  /** The commit marker on a changed line was activated: open that commit (in its own tab). */
  onOpenCommit: (sha: string, side: Side) => void;
};

const lineClass: Record<'left' | 'right', Partial<Record<DiffLine['kind'], string>>> = {
  left: { removed: 'bg-base-soft' },
  right: { added: 'bg-target-soft' },
};
const inlineClass: Record<DiffLine['kind'], string> = {
  context: '',
  removed: 'bg-left-soft',
  added: 'bg-right-soft',
};
const marker: Record<DiffLine['kind'], string> = { context: ' ', removed: '−', added: '+' };

function commitTitle(c: DivergenceCommit | undefined): string {
  if (!c) return '';
  return `${c.sha}\n${c.subject}\n${c.authorName} · authored ${formatDate(c.authorDate)}\nOpen this commit in a new tab`;
}

/** Changed lines in display order, for keyboard navigation. */
function changedRefs(diff: SnapshotFileDiff): LineRef[] {
  return diff.hunks.flatMap((h, hunk) =>
    h.lines.flatMap((l, line) => (l.kind === 'context' ? [] : [{ hunk, line }])),
  );
}

/**
 * Git's hunks for one file, Base → Target. Side by side (default), Base is on the left and
 * Target on the right, aligned row by row; inline, `−` lines are Base only and `+` lines Target
 * only. Each changed line carries the commit that currently accounts for it on its own side;
 * its commit marker opens that commit in a new tab. Click a hunk header or line to focus it;
 * `n`/`p` move between hunks, `j`/`k` (or the arrow keys) between changed lines.
 */
export function SnapshotDiffView({
  diff,
  leftLabel,
  rightLabel,
  focusedHunk,
  focusedLine,
  highlightCommit,
  layout,
  onLayoutChange,
  onFocusHunk,
  onFocusLine,
  onOpenCommit,
}: SnapshotDiffViewProps): JSX.Element {
  const isSide = (layout ?? 'side') === 'side';
  const commits = new Map(diff.commits.map((c) => [c.sha, c]));
  // A plain diff (nothing explained yet) has no commit column.
  const hasCommits = diff.commits.length > 0;
  const hunkRefs = useRef<Array<HTMLElement | null>>([]);
  const lineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusedLine) lineRef.current?.scrollIntoView({ block: 'nearest' });
    else if (focusedHunk !== undefined)
      hunkRefs.current[focusedHunk]?.scrollIntoView({ block: 'start' });
  }, [focusedHunk, focusedLine]);

  const count = diff.hunks.length;
  const go = (delta: number) => {
    if (count === 0) return;
    const next =
      focusedHunk === undefined
        ? delta > 0
          ? 0
          : count - 1
        : (focusedHunk + delta + count) % count;
    onFocusLine(undefined);
    onFocusHunk(next);
  };
  const moveLine = (delta: number) => {
    const refs = changedRefs(diff);
    if (refs.length === 0) return;
    const at = focusedLine
      ? refs.findIndex((r) => r.hunk === focusedLine.hunk && r.line === focusedLine.line)
      : -1;
    const next =
      refs[
        at < 0
          ? delta > 0
            ? 0
            : refs.length - 1
          : Math.min(refs.length - 1, Math.max(0, at + delta))
      ];
    if (next) {
      onFocusHunk(next.hunk);
      onFocusLine(next);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const actions: Record<string, () => void> = {
      n: () => {
        go(1);
      },
      p: () => {
        go(-1);
      },
      j: () => {
        moveLine(1);
      },
      k: () => {
        moveLine(-1);
      },
      ArrowDown: () => {
        moveLine(1);
      },
      ArrowUp: () => {
        moveLine(-1);
      },
      Escape: () => {
        onFocusLine(undefined);
      },
    };
    const action = actions[e.key];
    if (action && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      action();
    }
  };

  /** The commit marker of a changed line, if its commit is known. */
  const markerFor = (line: DiffLine, side: Side): ReactNode => {
    const commit = line.commit === undefined ? undefined : commits.get(line.commit);
    if (!hasCommits || commit === undefined) return hasCommits ? <span className="px-1" /> : null;
    return (
      <span className="px-1">
        <CommitMarker commit={commit} side={side} onOpen={onOpenCommit} />
      </span>
    );
  };

  const gridColumns = (side: 'left' | 'right' | 'inline') => {
    if (side === 'inline') {
      return hasCommits
        ? 'grid-cols-[3rem_3rem_1.25rem_5.5rem_minmax(0,1fr)]'
        : 'grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)]';
    }
    return hasCommits ? 'grid-cols-[3rem_5.5rem_minmax(0,1fr)]' : 'grid-cols-[3rem_minmax(0,1fr)]';
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-1.5 text-xs text-muted">
        <div role="group" aria-label="Diff layout" className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={isSide}
            title="Base and Target next to each other"
            className={clsx(
              'flex items-center gap-1 rounded border px-1.5 py-0.5',
              isSide ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover',
            )}
            onClick={() => {
              onLayoutChange?.('side');
            }}
          >
            <Columns2 className="size-3.5" aria-hidden /> Side by side
          </button>
          <button
            type="button"
            aria-pressed={!isSide}
            title="One list, with removed and added lines"
            className={clsx(
              'flex items-center gap-1 rounded border px-1.5 py-0.5',
              !isSide ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover',
            )}
            onClick={() => {
              onLayoutChange?.('inline');
            }}
          >
            <Rows3 className="size-3.5" aria-hidden /> Inline
          </button>
        </div>
        {!isSide && (
          <span aria-label="Diff direction" className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1">
              <span className="rounded bg-left-soft px-1 font-mono font-semibold text-left">−</span>
              only in Base <span className="font-mono text-ink">{leftLabel}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="rounded bg-right-soft px-1 font-mono font-semibold text-right">
                +
              </span>
              only in Target <span className="font-mono text-ink">{rightLabel}</span>
            </span>
          </span>
        )}
        {count > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <span aria-live="polite">
              {focusedHunk === undefined
                ? `${count} hunk${count === 1 ? '' : 's'}`
                : `Hunk ${focusedHunk + 1} of ${count}`}
            </span>
            <button
              type="button"
              aria-label="Previous hunk"
              title="Previous hunk (p)"
              className="rounded p-0.5 hover:bg-hover"
              onClick={() => {
                go(-1);
              }}
            >
              <ChevronUp className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next hunk"
              title="Next hunk (n)"
              className="rounded p-0.5 hover:bg-hover"
              onClick={() => {
                go(1);
              }}
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          </span>
        )}
      </div>

      <div
        role="region"
        aria-label="Snapshot diff"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto font-mono text-[12.5px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {isSide && (
          <div
            role="row"
            className="sticky top-0 z-10 grid grid-cols-2 border-b border-line bg-surface font-sans text-xs"
          >
            <div
              role="columnheader"
              aria-label="Base"
              className="flex min-w-0 items-center gap-1.5 border-r border-line px-3 py-1"
            >
              <span className="size-2.5 shrink-0 rounded-full bg-base" aria-hidden />
              <span className="font-semibold text-base">Base</span>
              <span className="truncate font-mono text-muted" title={leftLabel}>
                {leftLabel}
              </span>
            </div>
            <div
              role="columnheader"
              aria-label="Target"
              className="flex min-w-0 items-center gap-1.5 px-3 py-1"
            >
              <span className="size-2.5 shrink-0 rounded-full bg-target" aria-hidden />
              <span className="font-semibold text-target">Target</span>
              <span className="truncate font-mono text-muted" title={rightLabel}>
                {rightLabel}
              </span>
            </div>
          </div>
        )}
        {diff.hunks.map((hunk, h) => (
          <section
            key={hunk.header + String(h)}
            aria-label={`Hunk ${h + 1}`}
            data-focused={focusedHunk === h || undefined}
          >
            <button
              ref={(el) => {
                hunkRefs.current[h] = el;
              }}
              type="button"
              aria-pressed={focusedHunk === h}
              className={clsx(
                'block w-full border-y border-line px-3 py-0.5 text-left text-muted',
                focusedHunk === h ? 'bg-accent-soft text-accent' : 'bg-hover/60 hover:bg-hover',
              )}
              onClick={() => {
                onFocusLine(undefined);
                onFocusHunk(h);
              }}
            >
              {hunk.header}
            </button>
            {isSide
              ? alignRows(hunk).map((row, r) => (
                  <div key={r} role="row" className="grid grid-cols-2">
                    {(['left', 'right'] as const).map((side) => {
                      const item = side === 'left' ? row.left : row.right;
                      if (!item) {
                        return <div key={side} className="bg-missing" aria-hidden />;
                      }
                      const { line, index } = item;
                      const isChanged = line.kind !== 'context';
                      const isFocused = focusedLine?.hunk === h && focusedLine.line === index;
                      const isDimmed =
                        highlightCommit !== undefined &&
                        isChanged &&
                        line.commit !== highlightCommit;
                      const isMatch =
                        highlightCommit !== undefined && line.commit === highlightCommit;
                      return (
                        <div
                          key={side}
                          ref={isFocused ? lineRef : undefined}
                          role="cell"
                          data-side={side}
                          data-kind={line.kind}
                          data-commit={line.commit}
                          aria-current={isFocused || undefined}
                          className={clsx(
                            'grid items-start',
                            gridColumns(side),
                            side === 'left' ? 'border-r border-line' : undefined,
                            lineClass[side][line.kind],
                            isChanged && 'cursor-pointer',
                            isDimmed && 'opacity-40',
                            isMatch && 'ring-1 ring-inset ring-accent',
                            isFocused && 'outline outline-2 -outline-offset-2 outline-accent',
                          )}
                          onClick={() => {
                            onFocusHunk(h);
                            onFocusLine(isChanged ? { hunk: h, line: index } : undefined);
                          }}
                        >
                          <span className="select-none pr-2 text-right text-muted/80">
                            {(side === 'left' ? line.leftLine : line.rightLine) ?? ''}
                          </span>
                          {markerFor(line, side)}
                          <span className="whitespace-pre-wrap break-all pr-3">
                            {line.text || ' '}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))
              : hunk.lines.map((line, i) => {
                  const isChanged = line.kind !== 'context';
                  const isFocused = focusedLine?.hunk === h && focusedLine.line === i;
                  const isDimmed =
                    highlightCommit !== undefined && isChanged && line.commit !== highlightCommit;
                  const isMatch = highlightCommit !== undefined && line.commit === highlightCommit;
                  return (
                    <div
                      key={i}
                      ref={isFocused ? lineRef : undefined}
                      data-kind={line.kind}
                      data-commit={line.commit}
                      aria-current={isFocused || undefined}
                      className={clsx(
                        'grid items-start',
                        gridColumns('inline'),
                        inlineClass[line.kind],
                        isChanged && 'cursor-pointer',
                        isDimmed && 'opacity-40',
                        isMatch && 'ring-1 ring-inset ring-accent',
                        isFocused && 'outline outline-2 -outline-offset-2 outline-accent',
                      )}
                      onClick={() => {
                        onFocusHunk(h);
                        onFocusLine(isChanged ? { hunk: h, line: i } : undefined);
                      }}
                    >
                      <span className="select-none pr-2 text-right text-muted/80">
                        {line.leftLine ?? ''}
                      </span>
                      <span className="select-none pr-2 text-right text-muted/80">
                        {line.rightLine ?? ''}
                      </span>
                      <span
                        className={clsx(
                          'select-none text-center font-semibold',
                          line.kind === 'removed' && 'text-left',
                          line.kind === 'added' && 'text-right',
                        )}
                      >
                        {marker[line.kind]}
                      </span>
                      {markerFor(line, line.kind === 'added' ? 'right' : 'left')}
                      <span className="whitespace-pre-wrap break-all pr-3">{line.text || ' '}</span>
                    </div>
                  );
                })}
          </section>
        ))}
        {diff.truncated === true && (
          <p className="border-t border-line p-3 text-center text-muted">
            This diff was cut short to stay responsive; the remaining changes are not shown.
          </p>
        )}
      </div>
    </div>
  );
}

/** The commit that accounts for a changed line: its short SHA. Activating it opens the commit. */
function CommitMarker({
  commit,
  side,
  onOpen,
}: {
  commit: DivergenceCommit;
  /** The side whose history holds the commit: Base for removed lines, Target for added. */
  side: Side;
  onOpen: (sha: string, side: Side) => void;
}): JSX.Element {
  const placement = commitPlacement(commit);
  return (
    <button
      type="button"
      tabIndex={-1}
      title={commitTitle(commit)}
      aria-label={`Commit ${shortSha(commit.sha)}: ${commit.subject}`}
      className={clsx(
        'rounded px-1 text-[11px] leading-4 hover:underline',
        placement === 'both'
          ? 'border border-dashed border-line text-muted'
          : 'bg-surface/70 text-ink',
      )}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(commit.sha, side);
      }}
    >
      {shortSha(commit.sha)}
    </button>
  );
}
