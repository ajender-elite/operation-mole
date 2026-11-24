import type { GitSource, RepoInfo } from '@om/shared';
import { ArrowLeftRight } from 'lucide-react';
import { useState, type JSX, type SubmitEvent } from 'react';
import { emptyDraft, isComplete, toSource, type SourceDraft } from '../lib/source-draft.ts';
import { SourcePicker } from './source-picker.tsx';

type CompareFormProps = {
  initialLeft: GitSource | undefined;
  initialRight: GitSource | undefined;
  repos: RepoInfo[];
  user: string;
  sessionId: string;
  onSubmit: (left: GitSource, right: GitSource) => void;
  /** Names of the two sides (default Left and Right). */
  labels?: readonly [string, string];
  submitLabel?: string;
  /** Another thing to do with the same two sides (e.g. upstream analysis). */
  secondary?: { label: string; onSubmit: (left: GitSource, right: GitSource) => void };
};

/** Left and right pickers with swap and compare. Remount (via `key`) to reset from props. */
export function CompareForm({
  initialLeft,
  initialRight,
  repos,
  user,
  sessionId,
  onSubmit,
  labels = ['Left', 'Right'],
  submitLabel = 'Compare',
  secondary,
}: CompareFormProps): JSX.Element {
  const [left, setLeft] = useState<SourceDraft>(initialLeft ?? emptyDraft);
  const [right, setRight] = useState<SourceDraft>(initialRight ?? emptyDraft);
  const isReady = isComplete(left) && isComplete(right);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isReady) onSubmit(toSource(left), toSource(right));
  };

  const common = { repos, user, sessionId };
  return (
    <form onSubmit={submit} className="grid items-start gap-3 sm:grid-cols-[1fr_auto_1fr_auto]">
      <SourcePicker side={labels[0]} value={left} onChange={setLeft} {...common} />
      <button
        type="button"
        title="Swap sides"
        aria-label="Swap sides"
        className="mt-6 justify-self-center rounded-md border border-line p-2 text-muted hover:bg-hover"
        onClick={() => {
          setLeft(right);
          setRight(left);
        }}
      >
        <ArrowLeftRight className="size-4" aria-hidden />
      </button>
      <SourcePicker side={labels[1]} value={right} onChange={setRight} {...common} />
      <div className="mt-6 flex flex-col gap-1.5">
        <button
          type="submit"
          disabled={!isReady}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {submitLabel}
        </button>
        {secondary && isReady && (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-accent hover:bg-hover"
            onClick={() => {
              secondary.onSubmit(toSource(left), toSource(right));
            }}
          >
            {secondary.label}
          </button>
        )}
      </div>
    </form>
  );
}
