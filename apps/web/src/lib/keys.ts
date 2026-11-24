/**
 * Keyboard shortcuts of the explorer. A shortcut is ignored while the user is typing in a field, so `t` in a
 * search box is a letter, not a command.
 */

/** Whether `target` is a field the user types into (text input, text area, select or editable text). */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** One shortcut as the help dialog lists it: the keys, what they do, and the page where they work. */
export type Shortcut = { keys: string; label: string; where: string };

/**
 * Every shortcut of the explorer, in the order the help dialog lists them. `?` lists them; the others act on the
 * page named in `where` (anywhere in the session for `?`, `t`, `/` and `y`).
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: '?', label: 'Show these shortcuts', where: 'Anywhere in a session' },
  { keys: 't', label: 'Go to a file by name', where: 'Code' },
  { keys: '/', label: 'Search this ref', where: 'Code' },
  { keys: 'y', label: 'Copy a permalink to this view', where: 'Code' },
  { keys: 'j / k', label: 'Next or previous commit', where: 'Commits' },
  { keys: 'n / p', label: 'Next or previous difference', where: 'File compare' },
  { keys: 'Esc', label: 'Close a dialog or a sheet', where: 'Anywhere' },
];
