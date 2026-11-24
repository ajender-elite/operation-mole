import clsx from 'clsx';
import type { JSX, ReactNode } from 'react';

/** One tab an explorer page links to (the same repo and ref, or the repo's branches). */
export type ExploreLink = { label: string; url: string; isCurrent: boolean };

/**
 * The line above an explorer page: where the user is (the repo, then `picker` to change its ref) and the tabs
 * for that ref. Presentational: each link is opened through `onOpen`, so it lands in its own workspace tab.
 */
export function ExploreHeader({
  where,
  picker,
  links,
  onOpen,
}: {
  where: ReactNode;
  /** A control that picks the ref shown (see `RefPicker`), after `where`. */
  picker?: ReactNode | undefined;
  links: ExploreLink[];
  onOpen: (url: string) => void;
}): JSX.Element {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2">
      <p className="min-w-0 truncate text-sm font-medium text-ink">{where}</p>
      {picker}
      <nav aria-label="Explore" className="flex flex-wrap gap-1">
        {links.map((link) => (
          <button
            key={link.label}
            type="button"
            aria-current={link.isCurrent ? 'page' : undefined}
            className={clsx(
              'touch-target rounded-md px-2.5 py-1 text-sm',
              link.isCurrent ? 'bg-accent-soft font-medium text-ink' : 'text-muted hover:bg-hover',
            )}
            onClick={() => {
              onOpen(link.url);
            }}
          >
            {link.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
