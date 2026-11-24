import type { CherryPickStep, GitCherryPick } from '@om/shared';
import clsx from 'clsx';
import type { JSX } from 'react';
import { shortSha } from '../lib/attribution.ts';
import type { PickedAs } from '../lib/picked-as.ts';
import { STATUS_TEXT } from '../lib/series-checks.ts';
import { Loading, Notice } from './notice.tsx';

/**
 * One branch's check: its heading (`remote/branch`), then the verdict and steps once they arrive, or the
 * error. Presentational: the caller runs the check (see `usePooledQueries`) and passes its state.
 */
export function SeriesVerdict({
  heading,
  data,
  error,
  isPending,
  pickedAs,
}: {
  heading: string;
  data: GitCherryPick | undefined;
  error: string | undefined;
  isPending: boolean;
  /** The commit on this branch that carries the same change, when one was found (null when none). */
  pickedAs?: PickedAs | null | undefined;
}): JSX.Element {
  const isInHistory = data?.steps.some((step) => step.status === 'in-history') === true;
  return (
    <article
      aria-label={`Check on ${heading}`}
      className="space-y-2 rounded-md border border-line bg-surface p-3"
    >
      <h3 className="font-mono text-sm">{heading}</h3>
      {error !== undefined && <Notice tone="error">{error}</Notice>}
      {isPending && <Loading label={`Checking on ${heading}…`} />}
      {pickedAs !== undefined && pickedAs !== null && !isInHistory && (
        <p className="text-sm">
          Picked as <span className="font-mono">{shortSha(pickedAs.sha)}</span>{' '}
          <span className="text-muted">{pickedAs.subject}</span>:{' '}
          {pickedAs.how === 'trailer'
            ? 'the branch says it picked this commit (noted in its message).'
            : 'the same change is already on this branch, as another commit.'}
        </p>
      )}
      {data !== undefined && <Outcome result={data} />}
    </article>
  );
}

/** The verdict in words, then the steps: where the series stops and why, or why it was refused. */
export function Outcome({ result }: { result: GitCherryPick }): JSX.Element {
  if (result.outcome === 'invalid') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-error">
          Not checked:{' '}
          {result.issues.length === 1 ? 'one pick was' : `${result.issues.length} picks were`}{' '}
          refused before any was applied.
        </p>
        <ul className="list-inside list-disc text-sm">
          {result.issues.map((issue) => (
            <li key={`${issue.index}:${issue.problem}`}>
              Pick {issue.index + 1} <span className="font-mono">{shortSha(issue.commit)}</span>:{' '}
              {issue.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const total = result.steps.length;
  const stoppedAt = result.stoppedAt;
  const stop = stoppedAt === undefined ? undefined : result.steps[stoppedAt];
  const appliedThrough = stoppedAt ?? total;
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {stop === undefined || stoppedAt === undefined ? (
          <>
            Applies through pick {appliedThrough} of {total}: every pick applies, or is already
            there.
          </>
        ) : (
          <>
            Applies through pick {appliedThrough} of {total} · stops at pick {stoppedAt + 1}{' '}
            <span className="font-mono">{shortSha(stop.commit.sha)}</span>
            {stop.conflictedPaths.length > 0
              ? `: conflict in ${stop.conflictedPaths.join(', ')}`
              : ''}
          </>
        )}
      </p>
      <ol className="divide-y divide-line text-sm">
        {result.steps.map((step) => (
          <StepRow key={step.index} step={step} />
        ))}
      </ol>
      {result.warnings.length > 0 && (
        <ul className="list-inside list-disc text-xs text-muted">
          {result.warnings.map((warning) => (
            <li key={`${warning.index}:${warning.kind}`}>{warning.message}</li>
          ))}
        </ul>
      )}
      {result.changedPaths.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">
            {result.changedPaths.length} {result.changedPaths.length === 1 ? 'path' : 'paths'}{' '}
            changed by the picks before the stop
          </summary>
          <ul className="font-mono">
            {result.changedPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function StepRow({ step }: { step: CherryPickStep }): JSX.Element {
  const isStopped = step.status === 'conflict';
  return (
    <li
      className={clsx('flex flex-col gap-1 py-1.5', step.status === 'not-run' && 'text-muted')}
      data-status={step.status}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="w-6 text-right text-muted">{step.index + 1}</span>
        <span className={clsx('w-40', isStopped && 'font-medium text-error')}>
          {STATUS_TEXT[step.status]}
        </span>
        <span className="font-mono">{shortSha(step.commit.sha)}</span>
        <span className="min-w-0 truncate">{step.commit.subject}</span>
      </span>
      {step.status === 'applies' && step.files.length > 0 && (
        <span className="pl-8 text-xs text-muted">
          {step.files.length} {step.files.length === 1 ? 'file' : 'files'}
        </span>
      )}
      {isStopped &&
        step.conflictedFiles.map((file) => (
          <details key={file.path} className="pl-8 text-xs" open>
            <summary className="cursor-pointer font-mono">{file.path}</summary>
            {file.text === null ? (
              <p className="text-muted">Binary file: the conflict is not shown.</p>
            ) : (
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-canvas p-2 font-mono leading-5">
                {file.text}
              </pre>
            )}
          </details>
        ))}
    </li>
  );
}
