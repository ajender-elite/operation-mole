import type { DiffLine, DivergenceCommit, SnapshotFileDiff } from '@om/shared';
import clsx from 'clsx';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react';
import { commitPlacement, shortSha } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';

/** A changed line, by hunk index and line index within the hunk. */
export type LineRef = { hunk: number; line: number };

type SnapshotDiffViewProps = {
  diff: SnapshotFileDiff;
  leftLabel: string;
  rightLabel: string;
  focusedHunk: number | undefined;
  focusedLine: LineRef | undefined;
  /** Commit whose lines are emphasized (others dimmed). */
  highlightCommit: string | undefined;
  onFocusHunk: (hunk: number) => void;
  onFocusLine: (line: LineRef | undefined) => void;
  onSelectCommit: (sha: string) => void;
};

const lineClass: Record<DiffLine['kind'], string> = {
  context: '',
  removed: 'bg-left-soft',
  added: 'bg-right-soft',
};
const marker: Record<DiffLine['kind'], string> = { context: ' ', removed: '−', added: '+' };

function commitTitle(c: DivergenceCommit | undefined): string {
  if (!c) return '';
  return `${c.sha}\n${c.subject}\n${c.authorName} · authored ${formatDate(c.authorDate)}`;
}

/** Changed lines in display order, for keyboard navigation. */
function changedRefs(diff: SnapshotFileDiff): LineRef[] {
  return diff.hunks.flatMap((h, hunk) =>
    h.lines.flatMap((l, line) => (l.kind === 'context' ? [] : [{ hunk, line }])),
  );
}

/**
 * Git's hunks for one file, read Base → Target: `−` lines exist only in Base, `+` lines only
 * in Target. Each changed line carries the commit that currently accounts for it on its own
 * side. Click a hunk header or line to focus it; `n`/`p` move between hunks, `j`/`k` (or the
 * arrow keys) between changed lines.
 */
export function SnapshotDiffView({
  diff,
  leftLabel,
  rightLabel,
  focusedHunk,
  focusedLine,
  highlightCommit,
  onFocusHunk,
  onFocusLine,
  onSelectCommit,
}: SnapshotDiffViewProps): JSX.Element {
  const commits = new Map(diff.commits.map((c) => [c.sha, c]));
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-1.5 text-xs text-muted">
        <span aria-label="Diff direction" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1">
            <span className="rounded bg-left-soft px-1 font-mono font-semibold text-left">−</span>
            only in Base <span className="font-mono text-ink">{leftLabel}</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="rounded bg-right-soft px-1 font-mono font-semibold text-right">+</span>
            only in Target <span className="font-mono text-ink">{rightLabel}</span>
          </span>
        </span>
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
            {hunk.lines.map((line, i) => {
              const isChanged = line.kind !== 'context';
              const commit = line.commit === undefined ? undefined : commits.get(line.commit);
              const isFocused = focusedLine?.hunk === h && focusedLine.line === i;
              const isDimmed =
                highlightCommit !== undefined && isChanged && line.commit !== highlightCommit;
              const isMatch = highlightCommit !== undefined && line.commit === highlightCommit;
              const placement = commit ? commitPlacement(commit) : undefined;
              return (
                <div
                  key={i}
                  ref={isFocused ? lineRef : undefined}
                  data-kind={line.kind}
                  data-commit={line.commit}
                  aria-current={isFocused || undefined}
                  className={clsx(
                    'grid grid-cols-[3rem_3rem_1.25rem_5.5rem_minmax(0,1fr)] items-start',
                    lineClass[line.kind],
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
                  <span className="px-1">
                    {commit && (
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
                          onSelectCommit(commit.sha);
                        }}
                      >
                        {shortSha(commit.sha)}
                      </button>
                    )}
                  </span>
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
