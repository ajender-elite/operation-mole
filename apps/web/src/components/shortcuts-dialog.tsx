import type { JSX } from 'react';
import { useEffect } from 'react';
import { SHORTCUTS } from '../lib/keys.ts';

/**
 * The keyboard shortcuts of the explorer, as a list. Presentational: the list comes from `lib/keys.ts`, and the
 * caller decides when it opens. Escape or a click outside the dialog closes it.
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-canvas/70 p-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            className="touch-target rounded-md px-2 py-1 text-sm text-muted hover:bg-hover hover:text-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">Keys</th>
              <th scope="col">Action</th>
              <th scope="col">Where</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((shortcut) => (
              <tr key={shortcut.keys} className="border-b border-line last:border-b-0">
                <td className="whitespace-nowrap px-4 py-2 align-top">
                  <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-xs text-ink">
                    {shortcut.keys}
                  </kbd>
                </td>
                <td className="px-2 py-2">{shortcut.label}</td>
                <td className="px-4 py-2 text-xs text-muted">{shortcut.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
