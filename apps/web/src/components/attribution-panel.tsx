import type { DivergenceCommit } from '@om/shared';
import clsx from 'clsx';
import { ArrowLeft, Copy, GitCommitHorizontal, LoaderCircle, Search } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import {
  commitPlacement,
  shortSha,
  type CommitFootprint,
  type CommitShare,
  type ScopeAttribution,
} from '../lib/attribution.ts';
import { formatDate } from '../lib/dates.ts';

/** What the panel explains: the user's current focus. */
export type AttributionScope = {
  kind: 'Repository' | 'Folder' | 'File' | 'Hunk' | 'Line';
  /** e.g. the folder or file path, or "Hunk 2 of 5". */
  label: string;
};

/** Where directory attribution stands. */
export type AttributionProgress = {
  done: number;
  total: number;
  isRunning: boolean;
  errors: number;
};

type AttributionPanelProps = {
  scope: AttributionScope;
  /** Undefined while loading or before analysis starts. */
  attribution: ScopeAttribution | undefined;
  progress?: AttributionProgress | undefined;
  /** Shown instead of results (e.g. "binary file", "needs git snapshots"). */
  notice?: string | undefined;
  /** For large folders: analysis waits for this button. */
  onStart?: (() => void) | undefined;
  error?: string | undefined;
  selected: DivergenceCommit | undefined;
  /** Where the selected commit accounts for differences, among analyzed files. */
  footprint: CommitFootprint;
  analyzedFiles: number;
  onSelectCommit: (sha: string | undefined) => void;
  onOpenFile: (key: string, hunk: number | undefined) => void;
  /** Extra controls under the selected commit (e.g. "Analyze this folder"). */
  commitActions?: ReactNode;
};

const placementText = {
  left: 'Base history only',
  right: 'Target history only',
  both: 'In both histories',
  unknown: 'Reachability unknown',
} as const;

const placementClass = {
  left: 'bg-left-soft text-left',
  right: 'bg-right-soft text-right',
  both: 'border border-dashed border-line text-muted',
  unknown: 'bg-hover text-muted',
} as const;

function Placement({ commit }: { commit: DivergenceCommit }) {
  const p = commitPlacement(commit);
  return (
    <span className={clsx('rounded px-1.5 py-px text-[11px] font-medium', placementClass[p])}>
      {placementText[p]}
    </span>
  );
}

function Lines({ share }: { share: CommitShare }) {
  return (
    <span className="tabular-nums">
      {share.leftLines > 0 && <span className="text-left">−{share.leftLines}</span>}
      {share.leftLines > 0 && share.rightLines > 0 && ' '}
      {share.rightLines > 0 && <span className="text-right">+{share.rightLines}</span>}
      <span className="text-muted">
        {' '}
        line{share.leftLines + share.rightLines === 1 ? '' : 's'} · {share.hunks} hunk
        {share.hunks === 1 ? '' : 's'}
        {share.files.length > 1 ? ` · ${share.files.length} files` : ''}
      </span>
    </span>
  );
}

/**
 * "What currently accounts for this difference?" for the user's focus: the divergence
 * commits (git blame on each line's own side) ranked by the lines they account for, and, for
 * a selected commit, its details and the other differences it accounts for.
 */
export function AttributionPanel({
  scope,
  attribution,
  progress,
  notice,
  onStart,
  error,
  selected,
  footprint,
  analyzedFiles,
  onSelectCommit,
  onOpenFile,
  commitActions,
}: AttributionPanelProps): JSX.Element {
  return (
    <aside
      aria-label="Attribution"
      className="flex min-h-0 flex-col border-t border-line bg-surface text-sm lg:w-[23rem] lg:shrink-0 lg:border-l lg:border-t-0"
    >
      <header className="border-b border-line px-3 py-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          What accounts for this difference
        </p>
        <p className="mt-0.5 truncate" title={scope.label}>
          <span className="font-semibold">{scope.kind}</span>{' '}
          <span className="font-mono text-xs">{scope.label}</span>
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <CommitDetail
            commit={selected}
            footprint={footprint}
            analyzedFiles={analyzedFiles}
            onBack={() => {
              onSelectCommit(undefined);
            }}
            onOpenFile={onOpenFile}
            actions={commitActions}
          />
        ) : (
          <ScopeCommits
            attribution={attribution}
            progress={progress}
            notice={notice}
            onStart={onStart}
            error={error}
            onSelectCommit={onSelectCommit}
          />
        )}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-[11px] leading-snug text-muted">
        Current attribution from <span className="font-mono">git blame</span> on each line’s own
        side. A commit listed here accounts for the content as it is now; it is not necessarily
        where the content was first written or where the histories first diverged.
      </p>
    </aside>
  );
}

function ScopeCommits({
  attribution,
  progress,
  notice,
  onStart,
  error,
  onSelectCommit,
}: Pick<
  AttributionPanelProps,
  'attribution' | 'progress' | 'notice' | 'onStart' | 'error' | 'onSelectCommit'
>) {
  if (error !== undefined) {
    return (
      <p role="alert" className="m-3 rounded-md bg-error-soft p-2 text-error">
        {error}
      </p>
    );
  }
  if (notice !== undefined) return <p className="p-3 text-muted">{notice}</p>;
  if (onStart) {
    return (
      <div className="space-y-2 p-3 text-muted">
        <p>
          {progress?.total ?? 0} differing files here. Attributing them runs{' '}
          <span className="font-mono">git blame</span> on each one.
        </p>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-ink hover:bg-hover"
          onClick={onStart}
        >
          <Search className="size-4" aria-hidden />
          Attribute {progress?.total ?? 0} files
        </button>
      </div>
    );
  }
  return (
    <div>
      {progress && progress.total > 0 && (progress.isRunning || progress.errors > 0) && (
        <div
          className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted"
          aria-live="polite"
        >
          {progress.isRunning && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
          <span>
            Attributed {progress.done} of {progress.total} files
            {progress.errors > 0 ? ` (${progress.errors} failed)` : ''}
          </span>
          <progress className="ml-auto h-1.5 w-20" max={progress.total} value={progress.done} />
        </div>
      )}
      {!attribution ? (
        <p className="flex items-center gap-2 p-3 text-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Attributing…
        </p>
      ) : attribution.changedLines === 0 ? (
        <p className="p-3 text-muted">No changed lines to attribute here.</p>
      ) : (
        <>
          <ul aria-label="Divergence commits">
            {attribution.shares.map((share, i) => (
              <li key={share.commit.sha}>
                {commitPlacement(share.commit) === 'both' &&
                  (i === 0 ||
                    commitPlacement(attribution.shares[i - 1]?.commit ?? share.commit) !==
                      'both') && (
                    <p className="border-b border-line/70 bg-hover/60 px-3 py-1.5 text-xs text-muted">
                      <span className="font-medium text-ink">Shared history.</span> Content both
                      snapshots once had; the difference comes from the other side changing or
                      removing it.
                    </p>
                  )}
                <button
                  type="button"
                  className="block w-full border-b border-line/70 px-3 py-2 text-left hover:bg-hover"
                  onClick={() => {
                    onSelectCommit(share.commit.sha);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-accent">
                      {shortSha(share.commit.sha)}
                    </span>
                    <Placement commit={share.commit} />
                  </span>
                  <span className="mt-0.5 block truncate font-medium">{share.commit.subject}</span>
                  <span className="block truncate text-xs text-muted">
                    {share.commit.authorName} · {formatDate(share.commit.authorDate)}
                  </span>
                  <span className="mt-0.5 block text-xs">
                    <Lines share={share} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {attribution.unattributedLines > 0 && (
            <p className="px-3 py-2 text-xs text-muted">
              {attribution.unattributedLines} of {attribution.changedLines} changed lines have no
              attribution (binary, too large, or git blame failed).
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

const placementExplanation = {
  left: 'Only the Base snapshot contains this commit. The lines it accounts for are Base content that the Target does not have.',
  right:
    'Only the Target snapshot contains this commit. The lines it accounts for are Target content that the Base does not have.',
  both: 'Both snapshots contain this commit, so the lines it accounts for are shared history. The difference on those lines comes from the other side changing or removing them.',
  unknown: 'OM could not determine which snapshots contain this commit.',
} as const;

function CommitDetail({
  commit,
  footprint,
  analyzedFiles,
  onBack,
  onOpenFile,
  actions,
}: {
  commit: DivergenceCommit;
  footprint: CommitFootprint;
  analyzedFiles: number;
  onBack: () => void;
  onOpenFile: (key: string, hunk: number | undefined) => void;
  actions: ReactNode;
}) {
  const placement = commitPlacement(commit);
  return (
    <div className="space-y-3 p-3" aria-label="Commit details">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-accent hover:underline"
        onClick={onBack}
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All commits in this scope
      </button>
      <div>
        <p className="flex items-center gap-1.5">
          <GitCommitHorizontal className="size-4 text-muted" aria-hidden />
          <span className="font-mono text-xs">{commit.sha}</span>
          <button
            type="button"
            title="Copy SHA"
            aria-label="Copy SHA"
            className="rounded p-0.5 text-muted hover:bg-hover"
            onClick={() => {
              void navigator.clipboard.writeText(commit.sha).catch(() => undefined);
            }}
          >
            <Copy className="size-3.5" aria-hidden />
          </button>
        </p>
        <h3 className="mt-1 font-semibold">{commit.subject}</h3>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Field label="Author">
          {commit.authorName} &lt;{commit.authorEmail}&gt;
        </Field>
        <Field label="Authored">{formatDate(commit.authorDate)}</Field>
        <Field label="Committer">
          {commit.committerName} &lt;{commit.committerEmail}&gt;
        </Field>
        <Field label="Committed">{formatDate(commit.commitDate)}</Field>
        <Field label="In Base">
          {commit.inLeft === null ? 'unknown' : commit.inLeft ? 'yes' : 'no'}
        </Field>
        <Field label="In Target">
          {commit.inRight === null ? 'unknown' : commit.inRight ? 'yes' : 'no'}
        </Field>
      </dl>
      <p className="rounded-md bg-hover p-2 text-xs leading-snug">
        <Placement commit={commit} /> {placementExplanation[placement]}
      </p>
      <section aria-label="Differences this commit accounts for">
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
          Accounts for (in {analyzedFiles} analyzed file{analyzedFiles === 1 ? '' : 's'})
        </h4>
        {footprint.length === 0 ? (
          <p className="text-xs text-muted">No analyzed difference is attributed to it.</p>
        ) : (
          <ul className="space-y-0.5">
            {footprint.map((f) => (
              <li key={f.key}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
                  onClick={() => {
                    onOpenFile(f.key, f.hunks[0]);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.key}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {f.lines} line{f.lines === 1 ? '' : 's'} · {f.hunks.length} hunk
                    {f.hunks.length === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {actions}
      </section>
    </div>
  );
}
