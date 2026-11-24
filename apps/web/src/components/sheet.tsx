import clsx from 'clsx';
import { ArrowLeft } from 'lucide-react';
import { useEffect, type JSX, type ReactNode } from 'react';
import { MEDIA, useMediaQuery } from '../lib/media.ts';

/**
 * A panel that is a column beside the page on wide screens, and a full-height sheet over the page
 * below `lg`. The sheet closes on Escape and, when `backLabel` is given, shows a Back bar. The
 * page keeps the open state in the URL, so the Android back gesture closes it and a reload
 * restores it. Closed on a phone, it is hidden but stays mounted.
 */
export function Sheet({
  title,
  onClose,
  isOpen = true,
  backLabel,
  className,
  children,
}: {
  title: string;
  onClose: () => void;
  /** On a phone, a closed sheet is hidden. On a desktop it is always shown. */
  isOpen?: boolean;
  /** Text for the Back bar on a phone (for example "Back to commits"). */
  backLabel?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const isWide = useMediaQuery(MEDIA.wide);

  useEffect(() => {
    if (isWide || !isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [isWide, isOpen, onClose]);

  return (
    <section
      role={isWide ? 'region' : 'dialog'}
      aria-modal={isWide ? undefined : true}
      aria-label={title}
      className={clsx(
        'min-h-0 lg:contents',
        isOpen
          ? 'max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:flex max-lg:flex-col max-lg:bg-canvas'
          : 'max-lg:hidden',
        className,
      )}
    >
      {backLabel !== undefined && isOpen && (
        <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 lg:hidden">
          <button
            type="button"
            className="touch-target flex items-center gap-1 rounded px-1.5 py-1 text-accent hover:bg-hover"
            onClick={onClose}
          >
            <ArrowLeft className="size-4" aria-hidden /> {backLabel}
          </button>
          <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
        </header>
      )}
      {children}
    </section>
  );
}
