import type { JSX } from 'react';

/** A branch or tag of one remote that has a commit. */
export type ContainingRef = { remote: string; kind: 'branch' | 'tag'; name: string };

/**
 * The branches and tags, of every remote, that contain a commit ("Contained in"). Each opens in its own tab
 * through `onOpen`. Presentational: the caller asks the server (`POST /api/git/contains`).
 */
export function ContainedIn({
  refs,
  isLoading,
  error,
  onOpen,
}: {
  /** The refs that contain the commit, or undefined while the question is out. */
  refs: readonly ContainingRef[] | undefined;
  isLoading: boolean;
  /** Why the lookup failed, when it did. */
  error?: string | undefined;
  onOpen: (ref: ContainingRef) => void;
}): JSX.Element {
  if (error !== undefined) {
    return (
      <p role="status" className="text-xs text-error">
        Could not look up the branches and tags: {error}
      </p>
    );
  }
  if (isLoading || refs === undefined) {
    return <p className="text-xs text-muted">Looking for the branches and tags that have it…</p>;
  }
  if (refs.length === 0) {
    return <p className="text-xs text-muted">No branch or tag of any remote has this commit.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted">Contained in</span>
      {refs.map((ref) => {
        const label = ref.kind === 'tag' ? `${ref.name} (tag)` : `${ref.remote}/${ref.name}`;
        return (
          <button
            key={`${ref.kind}:${ref.remote}/${ref.name}`}
            type="button"
            className="touch-target rounded border border-line px-1.5 py-0.5 font-mono hover:bg-hover"
            onClick={() => {
              onOpen(ref);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
