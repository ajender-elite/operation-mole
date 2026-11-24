import clsx from 'clsx';
import { useState, type JSX, type ReactNode } from 'react';
import { MEDIA, useMediaQuery } from '../lib/media.ts';

/**
 * Text that may be cut short. With a mouse, its full text is in the tooltip. On a touch screen
 * (where there is no hover) tapping it shows the full text in a small popover.
 */
export function FullText({
  text,
  className,
  children,
}: {
  text: string;
  className?: string | undefined;
  children?: ReactNode;
}): JSX.Element {
  const isTouch = useMediaQuery(MEDIA.coarse);
  const [isOpen, setOpen] = useState(false);
  if (!isTouch) {
    return (
      <span title={text} className={clsx('truncate', className)}>
        {children ?? text}
      </span>
    );
  }
  return (
    <span className="relative inline-flex min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={isOpen}
        title={text}
        className={clsx('touch-target min-w-0 truncate text-left', className)}
        onClick={() => {
          setOpen((open) => !open);
        }}
      >
        {children ?? text}
      </button>
      {isOpen && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1 max-w-[80vw] break-all rounded-md border border-line bg-surface p-2 font-mono text-xs shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}
