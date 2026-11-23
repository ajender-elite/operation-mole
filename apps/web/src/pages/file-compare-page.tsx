import type { GitSource, SnapshotFileDiff } from '@om/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  GitCommitHorizontal,
  LoaderCircle,
  Rows3,
} from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AttributionPanel, type AttributionScope } from '../components/attribution-panel.tsx';
import { SnapshotDiffView, type LineRef } from '../components/snapshot-diff-view.tsx';
import {
  commitFootprint,
  differingFiles,
  shortSha,
  summarizeAttribution,
  type DiffTarget,
  type ScopeAttribution,
} from '../lib/attribution.ts';
import { folderCompareQuery } from '../lib/folder-compare.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { fileDiffQuery, useAnalyzedDiffs, type SnapshotPair } from '../lib/snapshot-diff.ts';
import { sourceFromParams, sourceLabel } from '../lib/sources.ts';
import { fileUrl, foldersUrl } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

const contentNotice = {
  identical: 'Same content on both sides (a rename without changes).',
  binary: 'Binary file: there are no lines to compare.',
  'too-large': 'Too large to diff as text.',
} as const;

const value = (params: URLSearchParams, name: string): string | undefined => {
  const v = params.get(name);
  return v === null || v === '' ? undefined : v;
};

/** One difference of a Folder Compare, as the URL describes it. */
type FileContext = {
  left: GitSource;
  right: GitSource;
  leftCommit: string;
  rightCommit: string;
  target: DiffTarget;
};

function fileContext(params: URLSearchParams): FileContext | undefined {
  const left = sourceFromParams(params, 'left');
  const right = sourceFromParams(params, 'right');
  const leftCommit = value(params, 'leftCommit');
  const rightCommit = value(params, 'rightCommit');
  const leftPath = value(params, 'leftPath');
  const rightPath = value(params, 'rightPath');
  const key = leftPath ?? rightPath;
  if (!left || !right || leftCommit === undefined || rightCommit === undefined) return undefined;
  if (key === undefined) return undefined;
  return {
    left,
    right,
    leftCommit,
    rightCommit,
    target: {
      key,
      ...(leftPath === undefined ? {} : { leftPath }),
      ...(rightPath === undefined ? {} : { rightPath }),
    },
  };
}

/**
 * File Compare: one difference between two snapshots in its own tab, at the exact commits the
 * Folder Compare resolved. It shows the difference; what accounts for it (git blame on each
 * changed line) is computed only when the user asks.
 */
export function FileComparePage(): JSX.Element {
  const [params] = useSearchParams();
  const context = fileContext(params);
  if (!context) {
    return (
      <p role="alert" className="m-auto p-8 text-center text-muted">
        This file comparison link is incomplete. Open the file from a Folder Compare.
      </p>
    );
  }
  return <FileCompare key={JSON.stringify(context)} context={context} />;
}

function statusOf(target: DiffTarget, diff: SnapshotFileDiff | undefined): string {
  const { leftPath, rightPath } = target;
  if (leftPath === undefined) return 'Only in target';
  if (rightPath === undefined) return 'Only in base';
  if (leftPath !== rightPath) return 'Renamed';
  return diff?.content === 'identical' ? 'Identical' : 'Different';
}

function FileCompare({ context }: { context: FileContext }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useWorkspace();
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const repos = session.data?.repos ?? [];
  const { left, right, leftCommit, rightCommit, target } = context;

  const isExplaining = params.get('explain') === '1';
  const isFullFile = params.get('full') === '1';
  const hunkParam = params.get('hunk');
  const focusedHunk = hunkParam !== null && /^\d+$/.test(hunkParam) ? Number(hunkParam) : undefined;
  const commitSha = value(params, 'commit');
  const [focusedLine, setFocusedLine] = useState<LineRef>();

  const pair: SnapshotPair = {
    user,
    sessionId,
    left: { ...left, branch: leftCommit },
    right: { ...right, branch: rightCommit },
  };
  const plain = useQuery(fileDiffQuery(pair, target, isFullFile, false));
  const explained = useQuery({
    ...fileDiffQuery(pair, target, isFullFile, true),
    enabled: isExplaining,
  });
  const diff = (isExplaining ? explained.data : undefined) ?? plain.data;
  const analyzed = useAnalyzedDiffs(pair);

  // The originating Folder Compare, if this browser tab has it: labels and previous/next.
  // Never run here; a file tab should not start a whole folder comparison.
  const folder = useQuery({
    ...folderCompareQuery(queryClient, user, sessionId, left, right),
    enabled: false,
  });
  const differences = folder.data ? differingFiles(folder.data.root) : [];
  const index = differences.findIndex((t) => t.key === target.key);

  const leftLabel = `${folder.data?.leftLabel ?? sourceLabel(left, repos)} (${shortSha(leftCommit)})`;
  const rightLabel = `${folder.data?.rightLabel ?? sourceLabel(right, repos)} (${shortSha(rightCommit)})`;

  const setSearch = (changes: Record<string, string | undefined>, shouldReplace = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined && v !== '') next.set(k, v);
      else next.delete(k);
    }
    void navigate({ search: `?${next}` }, { replace: shouldReplace });
  };

  const fileTab = (t: DiffTarget, extra: Record<string, string | undefined> = {}) =>
    fileUrl(user, sessionId, { left, right, leftCommit, rightCommit, target: t }, extra);

  const path =
    target.leftPath !== undefined &&
    target.rightPath !== undefined &&
    target.leftPath !== target.rightPath
      ? `${target.leftPath} → ${target.rightPath}`
      : target.key;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-1.5 text-sm">
        <button
          type="button"
          title="Back to the folder comparison, as you left it"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-hover"
          onClick={() => {
            workspace.open(foldersUrl(user, sessionId, left, right));
          }}
        >
          <ArrowLeft className="size-4" aria-hidden /> Folder compare
        </button>
        <h1 className="min-w-0 truncate font-mono font-medium" title={path}>
          {path}
        </h1>
        <span className="rounded bg-hover px-1.5 text-xs text-muted">{statusOf(target, diff)}</span>
        <div className="ml-auto flex items-center gap-1">
          {index >= 0 && (
            <>
              <button
                type="button"
                aria-label="Previous difference"
                title="Previous differing file"
                disabled={index <= 0}
                className="rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
                onClick={() => {
                  const prev = differences[index - 1];
                  if (prev) {
                    workspace.open(fileTab(prev, { explain: isExplaining ? '1' : undefined }), {
                      isExact: true,
                      isReplacing: true,
                    });
                  }
                }}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <span className="text-xs tabular-nums text-muted">
                {index + 1} / {differences.length}
              </span>
              <button
                type="button"
                aria-label="Next difference"
                title="Next differing file"
                disabled={index >= differences.length - 1}
                className="rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
                onClick={() => {
                  const next = differences[index + 1];
                  if (next) {
                    workspace.open(fileTab(next, { explain: isExplaining ? '1' : undefined }), {
                      isExact: true,
                      isReplacing: true,
                    });
                  }
                }}
              >
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </>
          )}
          <button
            type="button"
            aria-pressed={isFullFile}
            className={clsx(
              'flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
              isFullFile
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line hover:bg-hover',
            )}
            onClick={() => {
              setFocusedLine(undefined);
              setSearch({ full: isFullFile ? undefined : '1', hunk: undefined }, true);
            }}
          >
            <Rows3 className="size-3.5" aria-hidden /> Whole file
          </button>
          {diff?.content === 'text' && (
            <button
              type="button"
              aria-pressed={isExplaining}
              title="Find the commits that account for these changes"
              className={clsx(
                'flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
                isExplaining
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line hover:bg-hover',
              )}
              onClick={() => {
                setSearch(
                  isExplaining ? { explain: undefined, commit: undefined } : { explain: '1' },
                );
              }}
            >
              <GitCommitHorizontal className="size-3.5" aria-hidden /> Explain difference
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section aria-label={`File ${target.key}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {plain.isError ? (
            <div
              role="alert"
              className="m-4 rounded-md border border-error/40 bg-error-soft p-4 text-error"
            >
              {plain.error.message}
            </div>
          ) : !diff ? (
            <p className="m-auto flex items-center gap-2 p-8 text-muted">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Diffing…
            </p>
          ) : diff.content === 'text' ? (
            <SnapshotDiffView
              diff={diff}
              leftLabel={leftLabel}
              rightLabel={rightLabel}
              focusedHunk={focusedHunk}
              focusedLine={focusedLine}
              highlightCommit={commitSha}
              onFocusHunk={(h) => {
                if (h !== focusedHunk) setSearch({ hunk: String(h) }, true);
              }}
              onFocusLine={setFocusedLine}
              onSelectCommit={(sha) => {
                setSearch({ commit: sha });
              }}
            />
          ) : (
            <p className="m-auto max-w-md p-8 text-center text-muted">
              {contentNotice[diff.content]}
            </p>
          )}
        </section>

        {isExplaining && diff?.content === 'text' && (
          <Explanation
            target={target}
            diff={explained.data}
            error={explained.isError ? explained.error.message : undefined}
            focusedHunk={focusedHunk}
            focusedLine={focusedLine}
            commitSha={commitSha}
            footprint={commitSha === undefined ? [] : commitFootprint(commitSha, analyzed)}
            analyzedFiles={analyzed.length}
            onSelectCommit={(sha) => {
              setSearch({ commit: sha });
            }}
            onOpenFile={(key, hunk) => {
              const other = analyzed.find((e) => e.key === key)?.diff;
              const t: DiffTarget = {
                key,
                ...(other?.leftPath === undefined ? {} : { leftPath: other.leftPath }),
                ...(other?.rightPath === undefined ? {} : { rightPath: other.rightPath }),
              };
              const extra = {
                explain: '1',
                hunk: hunk === undefined ? undefined : String(hunk),
                commit: commitSha,
              };
              if (key === target.key) setSearch(extra, true);
              else workspace.open(fileTab(t, extra), { isExact: true });
            }}
            onClose={() => {
              setSearch({ explain: undefined, commit: undefined });
            }}
          />
        )}
      </div>
    </div>
  );
}

/** What accounts for this file's changes, narrowed to the focused hunk or line. */
function Explanation({
  target,
  diff,
  error,
  focusedHunk,
  focusedLine,
  commitSha,
  footprint,
  analyzedFiles,
  onSelectCommit,
  onOpenFile,
  onClose,
}: {
  target: DiffTarget;
  diff: SnapshotFileDiff | undefined;
  error: string | undefined;
  focusedHunk: number | undefined;
  focusedLine: LineRef | undefined;
  commitSha: string | undefined;
  footprint: ReturnType<typeof commitFootprint>;
  analyzedFiles: number;
  onSelectCommit: (sha: string | undefined) => void;
  onOpenFile: (key: string, hunk: number | undefined) => void;
  onClose: () => void;
}) {
  let scope: AttributionScope = { kind: 'File', label: target.key };
  let attribution: ScopeAttribution | undefined;
  let note = error;
  if (diff) {
    const hunk = focusedHunk === undefined ? undefined : diff.hunks[focusedHunk];
    const line =
      hunk && focusedLine ? diff.hunks[focusedLine.hunk]?.lines[focusedLine.line] : undefined;
    if (hunk && line) {
      scope = {
        kind: 'Line',
        label: `${line.kind === 'removed' ? `Base line ${line.leftLine ?? ''}` : `Target line ${line.rightLine ?? ''}`} · ${target.key}`,
      };
      attribution = summarizeAttribution([
        { key: target.key, diff, hunks: [{ ...hunk, lines: [line] }] },
      ]);
    } else if (hunk && focusedHunk !== undefined) {
      scope = { kind: 'Hunk', label: `${focusedHunk + 1} of ${diff.hunks.length} · ${target.key}` };
      attribution = summarizeAttribution([{ key: target.key, diff, hunks: [hunk] }]);
    } else {
      attribution = summarizeAttribution([{ key: target.key, diff }]);
    }
    if (diff.attributionNote !== undefined && attribution.shares.length === 0) {
      note = diff.attributionNote;
    }
  }
  const selected =
    commitSha === undefined ? undefined : diff?.commits.find((c) => c.sha === commitSha);
  return (
    <AttributionPanel
      scope={scope}
      attribution={attribution}
      error={note}
      selected={selected}
      footprint={footprint}
      analyzedFiles={analyzedFiles}
      onSelectCommit={onSelectCommit}
      onOpenFile={onOpenFile}
      onClose={onClose}
    />
  );
}
