import type { RepoInfo, Source } from '@om/shared';
import { ArrowLeftRight } from 'lucide-react';
import { useState, type JSX, type SubmitEvent } from 'react';
import { emptyDraft, isComplete, toSource, type SourceDraft } from '../lib/source-draft.ts';
import { SourcePicker } from './source-picker.tsx';

type CompareFormProps = {
  initialLeft: Source | undefined;
  initialRight: Source | undefined;
  repos: RepoInfo[];
  user: string;
  sessionId: string;
  onSubmit: (left: Source, right: Source) => void;
  /** Names of the two sides (default Base and Target). */
  labels?: readonly [string, string];
  /** Only git snapshots (no local folders), e.g. for upstream analysis. */
  isGitOnly?: boolean;
  submitLabel?: string;
};

/** Base and target pickers with swap and compare. Remount (via `key`) to reset from props. */
export function CompareForm({
  initialLeft,
  initialRight,
  repos,
  user,
  sessionId,
  onSubmit,
  labels = ['Base', 'Target'],
  isGitOnly = false,
  submitLabel = 'Compare',
}: CompareFormProps): JSX.Element {
  const blank: SourceDraft = isGitOnly ? { type: 'git', repoId: '', branch: '' } : emptyDraft;
  const [left, setLeft] = useState<SourceDraft>(initialLeft ?? blank);
  const [right, setRight] = useState<SourceDraft>(initialRight ?? blank);
  const isReady = isComplete(left) && isComplete(right);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isReady) onSubmit(toSource(left), toSource(right));
  };

  const common = { repos, user, sessionId, allowPaths: !isGitOnly };
  return (
    <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr_auto]">
      <SourcePicker side={labels[0]} value={left} onChange={setLeft} {...common} />
      <button
        type="button"
        title="Swap sides"
        aria-label="Swap sides"
        className="justify-self-center rounded-md border border-line p-2 text-muted hover:bg-hover"
        onClick={() => {
          setLeft(right);
          setRight(left);
        }}
      >
        <ArrowLeftRight className="size-4" aria-hidden />
      </button>
      <SourcePicker side={labels[1]} value={right} onChange={setRight} {...common} />
      <button
        type="submit"
        disabled={!isReady}
        className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </form>
  );
}
