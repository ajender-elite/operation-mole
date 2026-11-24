import type { GitRefEntry } from '@om/shared';
import type { JSX } from 'react';
import { useState } from 'react';

/** A branch or tag of one remote, or a commit SHA: what the picker opens. */
export type RefChoice = { remote: string; name: string };

/** A full commit SHA or an abbreviation of one (4 to 40 hex digits). */
const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;

/**
 * Chooses the ref an explorer page shows: a remote (when the repo has more than one), then one of its branches
 * and tags, or a commit SHA typed in. Presentational: the refs come from the caller and `onOpen` opens the
 * choice (in a tab of its own). The remote shown is a draft until a ref is opened.
 */
export function RefPicker({
  remotes,
  refs,
  isLoading,
  current,
  onOpen,
}: {
  remotes: readonly string[];
  /** Every branch and tag of every remote, or undefined while they load. */
  refs: readonly GitRefEntry[] | undefined;
  isLoading: boolean;
  current: RefChoice;
  onOpen: (choice: RefChoice) => void;
}): JSX.Element {
  const [remote, setRemote] = useState(current.remote);
  const [sha, setSha] = useState('');
  const ofRemote = (refs ?? []).filter((entry) => entry.remote === remote);
  const isCurrentListed =
    remote === current.remote && ofRemote.some((entry) => entry.name === current.name);
  const isSha = SHA_PATTERN.test(sha.trim());

  return (
    <span className="flex flex-wrap items-center gap-2">
      {remotes.length > 1 && (
        <label className="flex items-center gap-1 text-xs text-muted">
          <span>Remote</span>
          <select
            aria-label="Remote"
            value={remote}
            className="rounded-md border border-line bg-canvas px-1.5 py-0.5 text-sm text-ink"
            onChange={(event) => {
              setRemote(event.target.value);
            }}
          >
            {remotes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <select
        aria-label="Branch or tag"
        value={isCurrentListed ? current.name : ''}
        disabled={isLoading}
        className="max-w-56 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-sm text-ink"
        onChange={(event) => {
          onOpen({ remote, name: event.target.value });
        }}
      >
        {isLoading ? (
          <option value="" disabled>
            Loading…
          </option>
        ) : (
          <option value="" disabled>
            Choose a branch or tag…
          </option>
        )}
        {ofRemote
          .filter((entry) => entry.kind === 'branch')
          .map((entry) => (
            <option key={`branch/${entry.name}`} value={entry.name}>
              {entry.name}
            </option>
          ))}
        {ofRemote
          .filter((entry) => entry.kind === 'tag')
          .map((entry) => (
            <option key={`tag/${entry.name}`} value={entry.name}>
              {entry.name} (tag)
            </option>
          ))}
        {remote === current.remote && !isCurrentListed && (
          <option value={current.name}>{current.name}</option>
        )}
      </select>
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (isSha) onOpen({ remote, name: sha.trim() });
        }}
      >
        <input
          aria-label="Commit SHA"
          value={sha}
          placeholder="Commit SHA"
          spellCheck={false}
          className="w-28 rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-sm text-ink"
          onChange={(event) => {
            setSha(event.target.value);
          }}
        />
        <button
          type="submit"
          disabled={!isSha}
          className="touch-target rounded-md border border-line px-2 py-0.5 text-sm hover:bg-hover disabled:opacity-60"
        >
          Open commit
        </button>
      </form>
    </span>
  );
}
