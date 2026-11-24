import clsx from 'clsx';
import { MoreHorizontal } from 'lucide-react';
import { Fragment, useState, type JSX, type ReactNode } from 'react';
import { MEDIA, useMediaQuery } from '../lib/media.ts';

/** One control of a toolbar. Primary ones always show; secondary ones move into More on a phone. */
export type ToolbarItem = {
  key: string;
  priority: 'primary' | 'secondary';
  node: ReactNode;
};

/**
 * A row of page actions. On a phone (compact) or in landscape (short) the secondary actions move
 * into a More menu, so the primary ones stay in reach and the row never overflows. Choosing an
 * action closes the menu; Escape closes it too.
 */
export function Toolbar({
  items,
  className,
}: {
  items: ToolbarItem[];
  className?: string;
}): JSX.Element {
  const isCompact = useMediaQuery(MEDIA.compact);
  const isShort = useMediaQuery(MEDIA.short);
  const isCollapsed = isCompact || isShort;
  const [isMoreOpen, setMoreOpen] = useState(false);
  const primary = items.filter((item) => item.priority === 'primary');
  const secondary = items.filter((item) => item.priority === 'secondary');

  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      {primary.map((item) => (
        <Fragment key={item.key}>{item.node}</Fragment>
      ))}
      {!isCollapsed && secondary.map((item) => <Fragment key={item.key}>{item.node}</Fragment>)}
      {isCollapsed && secondary.length > 0 && (
        <div
          className="relative ml-auto"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMoreOpen(false);
          }}
        >
          <button
            type="button"
            aria-haspopup="true"
            aria-expanded={isMoreOpen}
            className="touch-target flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
            onClick={() => {
              setMoreOpen((open) => !open);
            }}
          >
            <MoreHorizontal className="size-3.5" aria-hidden /> More
          </button>
          {isMoreOpen && (
            <div
              role="group"
              aria-label="More actions"
              className="absolute right-0 z-30 mt-1 flex min-w-44 flex-col items-stretch gap-1 rounded-md border border-line bg-surface p-1.5 shadow-lg"
              onClick={() => {
                setMoreOpen(false);
              }}
            >
              {secondary.map((item) => (
                <Fragment key={item.key}>{item.node}</Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
