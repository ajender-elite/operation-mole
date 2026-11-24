import clsx from 'clsx';
import type { JSX, KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { rankPaths } from '../lib/fuzzy.ts';

/** How many matches the finder lists at once. */
export const FINDER_LIMIT = 50;

/**
 * Go to file: a dialog over the page that filters every path of the ref as you type. Arrow keys move through
 * the matches, Enter opens the one chosen, Escape closes. Presentational: the paths come from the caller.
 */
export function FileFinder({
  paths,
  isLoading,
  error,
  onPick,
  onClose,
}: {
  /** Every path of the ref, or undefined while they load. */
  paths: readonly string[] | undefined;
  isLoading: boolean;
  error?: string | undefined;
  onPick: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const matches = useMemo(() => rankPaths(paths ?? [], query, FINDER_LIMIT), [paths, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const chosen = matches[active];
      if (chosen !== undefined) {
        event.preventDefault();
        onPick(chosen);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-canvas/70 p-4 pt-[12vh]"
      onMouseDown={(event) => {
        // A click on the backdrop (not in the dialog) closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={matches.length > 0 ? `${listId}-${active}` : undefined}
          aria-label="Find a file"
          placeholder="Find a file by name"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="border-b border-line bg-surface px-4 py-3 font-mono text-sm outline-none"
        />
        {error !== undefined && (
          <p role="alert" className="px-4 py-2 text-sm text-error">
            {error}
          </p>
        )}
        {isLoading && <p className="px-4 py-2 text-sm text-muted">Loading files…</p>}
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching files"
          className="min-h-0 overflow-auto py-1"
        >
          {matches.map((path, index) => (
            <li
              key={path}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={clsx(
                'cursor-pointer truncate px-4 py-1 font-mono text-sm',
                index === active ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-hover',
              )}
              onMouseEnter={() => {
                setActive(index);
              }}
              onClick={() => {
                onPick(path);
              }}
            >
              {path}
            </li>
          ))}
        </ul>
        {paths !== undefined && matches.length === 0 && !isLoading && (
          <p className="px-4 py-2 text-sm text-muted">No file matches “{query}”.</p>
        )}
      </div>
    </div>
  );
}
