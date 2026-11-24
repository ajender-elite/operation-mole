import type { DiffLine, DivergenceCommit, SnapshotFileDiff } from '@om/shared';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, Columns2, Rows3 } from 'lucide-react';
import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { commitPlacement, shortSha } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';
import type { HighlightedToken } from '../lib/highlight.ts';
import type { BlameMark } from '../lib/blame.ts';
import { MEDIA, useMediaQuery } from '../lib/media.ts';
import { FullText } from './full-text.tsx';
import { alignRows } from '../lib/diff-rows.ts';

/** A changed line, by hunk index and line index within the hunk. */
export type LineRef = { hunk: number; line: number };

/** `left` is Left, `right` is Right. */
export type Side = 'left' | 'right';

/** `side`: Left and Right next to each other (the default). `inline`: one list with +/- lines. */
export type DiffLayout = 'side' | 'inline';

type SnapshotDiffViewProps = {
  diff: SnapshotFileDiff;
  leftLabel: string;
  rightLabel: string;
  focusedHunk: number | undefined;
  focusedLine: LineRef | undefined;
  /** Commit whose lines are emphasized (others dimmed). */
  highlightCommit: string | undefined;
  /** Syntax colours: tokens[hunk][line] (see lib/diff-highlight.ts). Plain text where absent. */
  tokens?: HighlightedToken[][][] | undefined;
  /** Undefined means the default, side by side. */
  layout?: DiffLayout | undefined;
  onLayoutChange?: ((layout: DiffLayout) => void) | undefined;
  onFocusHunk: (hunk: number) => void;
  onFocusLine: (line: LineRef | undefined) => void;
  /** The commit marker on a changed line was activated: open that commit (in its own tab). */
  onOpenCommit: (sha: string, side: Side) => void;
  /** Whether long code lines wrap (true, the default) or scroll sideways in their pane. */
  wrap?: boolean;
  /** Shows the Wrap lines toggle when given. */
  onWrapChange?: ((wrap: boolean) => void) | undefined;
  /**
   * The last change to each line of a side (every line, context included), when that side is blamed.
   * A blamed side gets its own column: a line's commit there is the last one to change it in that
   * side's history, not necessarily the cause of the difference.
   */
  blame?:
    { left?: ReadonlyMap<number, BlameMark>; right?: ReadonlyMap<number, BlameMark> } | undefined;
  /**
   * Lines (by their number on each side, which is the same for identical content) whose last change is a
   * different commit on each side. Marked, counted, and reached with Previous and Next difference.
   */
  differingLines?: ReadonlySet<number> | undefined;
};

const lineClass: Record<'left' | 'right', Partial<Record<DiffLine['kind'], string>>> = {
  left: { removed: 'bg-side-left-soft' },
  right: { added: 'bg-side-right-soft' },
};
const inlineClass: Record<DiffLine['kind'], string> = {
  context: '',
  removed: 'bg-side-left-soft',
  added: 'bg-side-right-soft',
};
const marker: Record<DiffLine['kind'], string> = { context: ' ', removed: '−', added: '+' };

/** Long lines wrap by default; with wrapping off they keep one line and scroll sideways in their pane. */
function codeClass(wrap: boolean): string {
  return wrap
    ? 'whitespace-pre-wrap [overflow-wrap:anywhere] pr-3'
    : 'overflow-x-auto whitespace-pre pr-3';
}

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
 * Git's hunks for one file, Left → Right. Side by side (default), Left is on the left and
 * Right on the right, aligned row by row; inline, `−` lines are Left only and `+` lines Right
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
  tokens,
  layout,
  onLayoutChange,
  onFocusHunk,
  onFocusLine,
  onOpenCommit,
  wrap = true,
  onWrapChange,
  blame,
  differingLines,
}: SnapshotDiffViewProps): JSX.Element {
  // On a touch screen there are no j/k keys: Next and Previous change buttons take their place.
  const isTouch = useMediaQuery(MEDIA.coarse);
  const isSide = (layout ?? 'side') === 'side';
  const commits = new Map(diff.commits.map((c) => [c.sha, c]));
  // A plain diff (nothing explained yet) has no commit column.
  const hasCommits = diff.commits.length > 0;
  const isBlamed = (side: Side) => blame?.[side] !== undefined;
  // Blamed sides replace the explanation's commit column, so each side's marker has one place.
  const inlineColumns =
    isBlamed('left') || isBlamed('right')
      ? Number(isBlamed('left')) + Number(isBlamed('right'))
      : hasCommits
        ? 1
        : 0;
  const hunkRefs = useRef<Array<HTMLElement | null>>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [differenceAt, setDifferenceAt] = useState(-1);
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
  // The marked lines on the left, in order: Previous and Next difference step through them.
  const jumpToDifference = (delta: 1 | -1) => {
    const marks =
      rootRef.current?.querySelectorAll<HTMLElement>('[data-differs][data-side="left"]') ?? [];
    if (marks.length === 0) return;
    const next =
      differenceAt < 0
        ? delta > 0
          ? 0
          : marks.length - 1
        : (differenceAt + delta + marks.length) % marks.length;
    setDifferenceAt(next);
    marks[next]?.scrollIntoView({ block: 'center' });
  };
  const differingCount = differingLines?.size ?? 0;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // On identical content the lines that differ by commit are what n and p step through; there are no hunks.
    const step = (delta: 1 | -1) => {
      if (differingCount > 0) jumpToDifference(delta);
      else go(delta);
    };
    const actions: Record<string, () => void> = {
      n: () => {
        step(1);
      },
      p: () => {
        step(-1);
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
      // Narrower gutters below 640px (a phone held upright); the full widths from `sm` up.
      if (inlineColumns === 2) {
        return 'grid-cols-[2.5rem_2.5rem_1.25rem_4.5rem_4.5rem_minmax(0,1fr)] sm:grid-cols-[3rem_3rem_1.25rem_5.5rem_5.5rem_minmax(0,1fr)]';
      }
      return inlineColumns === 1
        ? 'grid-cols-[2.5rem_2.5rem_1.25rem_4.5rem_minmax(0,1fr)] sm:grid-cols-[3rem_3rem_1.25rem_5.5rem_minmax(0,1fr)]'
        : 'grid-cols-[2.5rem_2.5rem_1.25rem_minmax(0,1fr)] sm:grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)]';
    }
    return hasCommits || isBlamed(side)
      ? 'grid-cols-[2.5rem_4.5rem_minmax(0,1fr)] sm:grid-cols-[3rem_5.5rem_minmax(0,1fr)]'
      : 'grid-cols-[2.5rem_minmax(0,1fr)] sm:grid-cols-[3rem_minmax(0,1fr)]';
  };

  /** The blame marker of one line of a blamed side, or an empty cell when git blamed none. */
  const blameCell = (side: Side, lineNumber: number | undefined): ReactNode => {
    const mark = lineNumber === undefined ? undefined : blame?.[side]?.get(lineNumber);
    if (mark === undefined) return <span className="px-1" />;
    return (
      <span className="px-1">
        <BlameMarker mark={mark} side={side} onOpen={onOpenCommit} />
      </span>
    );
  };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {differingCount > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-1.5 text-xs text-muted"
        >
          <span>
            {differingCount} {differingCount === 1 ? 'line is' : 'lines are'} last changed by a
            different commit on each side
          </span>
          <button
            type="button"
            className="rounded border border-line px-1.5 py-0.5 hover:bg-hover"
            onClick={() => {
              jumpToDifference(-1);
            }}
          >
            Previous difference
          </button>
          <button
            type="button"
            className="rounded border border-line px-1.5 py-0.5 hover:bg-hover"
            onClick={() => {
              jumpToDifference(1);
            }}
          >
            Next difference
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-1.5 text-xs text-muted">
        <div role="group" aria-label="Diff layout" className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={isSide}
            title="Left and Right next to each other"
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
        {onWrapChange && (
          <button
            type="button"
            aria-pressed={wrap}
            title="Wrap long lines, or scroll them sideways"
            className={clsx(
              'touch-target flex items-center gap-1 rounded border px-1.5 py-0.5',
              wrap ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover',
            )}
            onClick={() => {
              onWrapChange(!wrap);
            }}
          >
            Wrap lines
          </button>
        )}
        {!isSide && (
          <span aria-label="Diff direction" className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1">
              <span className="rounded bg-side-left-soft px-1 font-mono font-semibold text-side-left">
                −
              </span>
              only in Left <span className="font-mono text-ink">{leftLabel}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="rounded bg-side-right-soft px-1 font-mono font-semibold text-side-right">
                +
              </span>
              only in Right <span className="font-mono text-ink">{rightLabel}</span>
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
            {isTouch && (
              <button
                type="button"
                aria-label="Previous change"
                title="Previous change"
                className="touch-target rounded p-0.5 hover:bg-hover"
                onClick={() => {
                  moveLine(-1);
                }}
              >
                <ChevronUp className="size-4" aria-hidden />
              </button>
            )}
            {isTouch && (
              <button
                type="button"
                aria-label="Next change"
                title="Next change"
                className="touch-target rounded p-0.5 hover:bg-hover"
                onClick={() => {
                  moveLine(1);
                }}
              >
                <ChevronDown className="size-4" aria-hidden />
              </button>
            )}
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
              aria-label="Left"
              className="flex min-w-0 items-center gap-1.5 border-r border-line px-3 py-1"
            >
              <span className="size-2.5 shrink-0 rounded-full bg-side-left-dot" aria-hidden />
              <span className="font-semibold text-side-left">Left</span>
              <FullText text={leftLabel} className="font-mono text-muted" />
            </div>
            <div
              role="columnheader"
              aria-label="Right"
              className="flex min-w-0 items-center gap-1.5 px-3 py-1"
            >
              <span className="size-2.5 shrink-0 rounded-full bg-side-right-dot" aria-hidden />
              <span className="font-semibold text-side-right">Right</span>
              <FullText text={rightLabel} className="font-mono text-muted" />
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
                'sticky top-6 z-[5] block w-full border-y border-line px-3 py-0.5 text-left text-muted',
                focusedHunk === h ? 'bg-accent-soft text-accent' : 'bg-hover hover:bg-hover',
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
                      const lineNumber = side === 'left' ? line.leftLine : line.rightLine;
                      const isDiffering =
                        lineNumber !== undefined && differingLines?.has(lineNumber) === true;
                      return (
                        <div
                          key={side}
                          ref={isFocused ? lineRef : undefined}
                          role="cell"
                          data-side={side}
                          data-differs={isDiffering || undefined}
                          data-kind={line.kind}
                          data-commit={line.commit}
                          aria-current={isFocused || undefined}
                          className={clsx(
                            'grid items-start',
                            gridColumns(side),
                            side === 'left' ? 'border-r border-line' : undefined,
                            lineClass[side][line.kind],
                            isDiffering && 'bg-modified-soft',
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
                          {isBlamed(side)
                            ? blameCell(side, side === 'left' ? line.leftLine : line.rightLine)
                            : markerFor(line, side)}
                          <span className={codeClass(wrap)}>
                            {codeText(line.text, tokens?.[h]?.[index])}
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
                          line.kind === 'removed' && 'text-side-left',
                          line.kind === 'added' && 'text-side-right',
                        )}
                      >
                        {marker[line.kind]}
                      </span>
                      {isBlamed('left') || isBlamed('right') ? (
                        <>
                          {isBlamed('left') && blameCell('left', line.leftLine)}
                          {isBlamed('right') && blameCell('right', line.rightLine)}
                        </>
                      ) : (
                        markerFor(line, line.kind === 'added' ? 'right' : 'left')
                      )}
                      <span className={codeClass(wrap)}>
                        {codeText(line.text, tokens?.[h]?.[i])}
                      </span>
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

/**
 * The last change to one line of a blamed side. Labelled as that: the last change in this side's
 * history, which is not necessarily what caused the difference. A commit the other side has too
 * is shared, drawn dashed.
 */
function BlameMarker({
  mark,
  side,
  onOpen,
}: {
  mark: BlameMark;
  side: Side;
  onOpen: (sha: string, side: Side) => void;
}): JSX.Element {
  const label = side === 'left' ? 'Left' : 'Right';
  return (
    <button
      type="button"
      aria-label={`Last change in ${label}: ${mark.subject}`}
      title={[
        `${shortSha(mark.sha)} · ${mark.subject}`,
        `${mark.authorName} · ${formatDate(mark.authorDate)}`,
        `The last change to this line in ${label}'s history. It is not necessarily what caused the difference.`,
        mark.isShared ? 'Shared: the other side has this commit too.' : undefined,
      ]
        .filter((line) => line !== undefined)
        .join('\n')}
      className={clsx(
        'font-mono text-xs text-muted hover:text-ink',
        mark.isShared && 'border-b border-dashed border-muted',
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(mark.sha, side);
      }}
    >
      {shortSha(mark.sha)}
    </button>
  );
}

/**
 * The commit that accounts for a changed line: its short SHA. On a desktop, activating it opens the
 * commit. On a touch screen it first shows the commit (subject, author, date), and opens it from there,
 * so a stray tap never opens a tab.
 */
function CommitMarker({
  commit,
  side,
  onOpen,
}: {
  commit: DivergenceCommit;
  /** The side whose history holds the commit: Left for removed lines, Right for added. */
  side: Side;
  onOpen: (sha: string, side: Side) => void;
}): JSX.Element {
  const isTouch = useMediaQuery(MEDIA.coarse);
  const [isDetailsOpen, setDetailsOpen] = useState(false);
  const placement = commitPlacement(commit);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        tabIndex={-1}
        title={commitTitle(commit)}
        aria-label={`Commit ${shortSha(commit.sha)}: ${commit.subject}`}
        aria-expanded={isTouch ? isDetailsOpen : undefined}
        className={clsx(
          'touch-target rounded px-1 text-[11px] leading-4 hover:underline',
          placement === 'both'
            ? 'border border-dashed border-line text-muted'
            : 'bg-surface/70 text-ink',
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (isTouch) setDetailsOpen((open) => !open);
          else onOpen(commit.sha, side);
        }}
      >
        {shortSha(commit.sha)}
      </button>
      {isTouch && isDetailsOpen && (
        <span
          role="dialog"
          aria-label="Commit details"
          className="absolute left-0 top-full z-30 mt-1 flex w-64 max-w-[80vw] flex-col gap-1.5 rounded-md border border-line bg-surface p-3 text-left font-sans text-sm shadow-lg"
          onClick={(e) => {
            e.stopPropagation();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDetailsOpen(false);
          }}
        >
          <span className="font-mono text-xs text-muted">{commit.sha}</span>
          <span className="font-semibold text-ink">{commit.subject}</span>
          <span className="text-xs text-muted">
            {commit.authorName} · authored {formatDate(commit.authorDate)}
          </span>
          <span className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              className="touch-target rounded px-2 py-1 text-xs text-muted hover:bg-hover"
              onClick={() => {
                setDetailsOpen(false);
              }}
            >
              Close
            </button>
            <button
              type="button"
              className="touch-target rounded border border-line px-2.5 py-1 text-xs text-accent hover:bg-hover"
              onClick={() => {
                setDetailsOpen(false);
                onOpen(commit.sha, side);
              }}
            >
              Open commit
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * A line's code: its syntax tokens when they are known (each coloured with its palette colour), else the text.
 * An empty line shows a space, so its row keeps its height.
 */
function codeText(text: string, tokens: HighlightedToken[] | undefined): ReactNode {
  if (tokens === undefined || tokens.length === 0) return text || ' ';
  return tokens.map((token, k) => (
    <span key={k} style={token.color === undefined ? undefined : { color: token.color }}>
      {token.content}
    </span>
  ));
}
