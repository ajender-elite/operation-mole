import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

/** A message in the page's body: neutral, or an error. */
export function Notice({
  tone = 'muted',
  children,
  className,
}: {
  tone?: 'muted' | 'error';
  children: ReactNode;
  className?: string;
}): JSX.Element {
  if (tone === 'error') {
    return (
      <div
        role="alert"
        className={clsx(
          'm-4 rounded-md border border-error/40 bg-error-soft p-4 text-error',
          className,
        )}
      >
        {children}
      </div>
    );
  }
  return <p className={clsx('m-auto p-8 text-center text-muted', className)}>{children}</p>;
}

/** The "Loading…" line a query shows until its data arrives. */
export function Loading({ label }: { label: string }): JSX.Element {
  return (
    <p className="m-auto flex items-center gap-2 p-8 text-muted">
      <LoaderCircle className="size-4 animate-spin" aria-hidden /> {label}
    </p>
  );
}
