import type { CommitInfo } from '@om/shared';
import clsx from 'clsx';
import type { JSX, ReactNode } from 'react';
import { shortSha } from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';

/**
 * One commit in a list: its SHA, subject, author and date. The row's main button selects or opens the commit
 * (what that means is the caller's choice); the second button adds the commit to the series. Presentational.
 */
export function CommitRow({
  commit,
  badge,
  isCurrent = false,
  isPicked,
  onSelect,
  onAddToSeries,
}: {
  commit: CommitInfo;
  /** A short label before the SHA, for example how a commit relates to the other side. */
  badge?: ReactNode;
  isCurrent?: boolean;
  isPicked: boolean;
  onSelect: () => void;
  onAddToSeries: () => void;
}): JSX.Element {
  return (
    <li className="flex items-stretch">
      <button
        type="button"
        aria-current={isCurrent ? 'true' : undefined}
        className={clsx(
          'flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left hover:bg-hover',
          isCurrent && 'bg-accent-soft',
        )}
        onClick={onSelect}
      >
        <span className="flex items-center gap-2 text-xs">
          {badge}
          <span className="font-mono text-muted">{shortSha(commit.sha)}</span>
        </span>
        <span className="truncate text-sm text-ink">{commit.subject}</span>
        <span className="text-xs text-muted">
          {commit.authorName} · {formatDate(commit.authorDate)}
        </span>
      </button>
      <button
        type="button"
        aria-pressed={isPicked}
        aria-label={`${isPicked ? 'In the series' : 'Add to the series'}: ${shortSha(commit.sha)}`}
        disabled={isPicked}
        className="touch-target mx-2 shrink-0 self-center rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-60"
        onClick={onAddToSeries}
      >
        {isPicked ? 'In series' : 'Add to series'}
      </button>
    </li>
  );
}
