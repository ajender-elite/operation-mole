import type { GitAncestry, GitBlame, GitSource, SnapshotFileDiff } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  Rows3,
} from 'lucide-react';
import { useState, type JSX } from 'react';
import { MEDIA, useMediaQuery } from '../lib/media.ts';
import { useNavigate, useSearchParams } from 'react-router';
import { AttributionPanel, type AttributionScope } from '../components/attribution-panel.tsx';
import { Sheet } from '../components/sheet.tsx';
import { FullText } from '../components/full-text.tsx';
import { Toolbar } from '../components/toolbar.tsx';
import {
  SnapshotDiffView,
  type DiffLayout,
  type LineRef,
} from '../components/snapshot-diff-view.tsx';
import {
  commitFootprint,
  differingFiles,
  shortSha,
  summarizeAttribution,
  type DiffTarget,
  type ScopeAttribution,
} from '../lib/attribution.ts';
import { ancestryQuery, blameMarks, blameQuery, sharedWith, type BlameMark } from '../lib/blame.ts';
import { folderCompareQuery } from '../lib/folder-compare.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { useDiffHighlight } from '../lib/diff-highlight.ts';
import { fileDiffQuery, useAnalyzedDiffs, type SnapshotPair } from '../lib/snapshot-diff.ts';
import { sourceFromParams, sourceLabel } from '../lib/sources.ts';
import { commitsUrl, commitUrl, fileUrl, foldersUrl } from '../lib/urls.ts';
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

/** The sides the URL asks to blame (`blame=left`, `right`, or `left,right`). */
function blamedSides(param: string | null): Set<'left' | 'right'> {
  const sides = new Set<'left' | 'right'>();
  for (const part of (param ?? '').split(',')) {
    if (part === 'left' || part === 'right') sides.add(part);
  }
  return sides;
}

/**
 * The lines (by number) whose last change is a different commit in the two histories. Only lines both blames
 * name count; identical content has the same line numbers on both sides.
 */
function differingLinesOf(left: GitBlame, right: GitBlame): Set<number> {
  const rightByLine = new Map(right.lines.map((line) => [line.line, line.commit]));
  const differing = new Set<number>();
  for (const line of left.lines) {
    const other = rightByLine.get(line.line);
    if (other !== undefined && other !== line.commit) differing.add(line.line);
  }
  return differing;
}

/** The distinct commits a blame names, in the order it gives them (at most 200, the ancestry limit). */
function commitsOf(blame: GitBlame | undefined): string[] {
  if (blame === undefined) return [];
  return [...new Set(blame.lines.map((line) => line.commit))].slice(0, 200);
}

/** The blame marks of one side: none while it loads, and a shared commit is marked as such. */
function marksOf(
  blame: GitBlame | undefined,
  ancestry: GitAncestry | undefined,
): Map<number, BlameMark> {
  return blame === undefined
    ? new Map<number, BlameMark>()
    : blameMarks(blame, sharedWith(ancestry));
}

function statusOf(target: DiffTarget, diff: SnapshotFileDiff | undefined): string {
  const { leftPath, rightPath } = target;
  if (leftPath === undefined) return 'Only in right';
  if (rightPath === undefined) return 'Only in left';
  if (leftPath !== rightPath) return 'Renamed';
  return diff?.content === 'identical' ? 'Identical' : 'Different';
}

function FileCompare({ context }: { context: FileContext }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const repos = session.data?.repos ?? [];
  const { left, right, leftCommit, rightCommit, target } = context;

  const isExplaining = params.get('explain') === '1';
  const isFullFile = params.get('full') === '1';
  // Side by side unless the user chose inline; the choice lives in the URL with the rest of the view.
  // An explicit choice (view=side|inline, kept in the URL) wins; otherwise a phone held upright gets inline.
  const isCompact = useMediaQuery(MEDIA.compact);
  const viewParam = params.get('view');
  const layout: DiffLayout =
    viewParam === 'side' || viewParam === 'inline' ? viewParam : isCompact ? 'inline' : 'side';
  const isWrapping = params.get('wrap') !== '0';
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
  // An identical file still shows both panes with its whole content. The full-file diff (one context hunk)
  // is asked for only once the plain diff says the content is the same, so changed files stay small.
  const identicalFull = useQuery({
    ...fileDiffQuery(pair, target, true, false),
    enabled: plain.data?.content === 'identical' && !isFullFile,
  });
  const fullIdentical = isFullFile ? plain.data : identicalFull.data;
  const identicalPanes =
    diff?.content === 'identical' && (fullIdentical?.hunks.length ?? 0) > 0
      ? fullIdentical
      : undefined;
  const analyzed = useAnalyzedDiffs(pair);
  // The lines of the diff, coloured by the language of the file (plain text when the file has none).
  const shownDiff = identicalPanes ?? diff;
  const highlight = useDiffHighlight(
    shownDiff?.hunks ?? [],
    shownDiff?.rightPath ?? shownDiff?.leftPath ?? '',
  );

  // Blame of each side asked for: the last change to every line in that side's own history. A
  // commit the other side also has is shared (dashed), so it is marked as such: one ancestry check each.
  const blamed = blamedSides(params.get('blame'));
  const leftSource: GitSource = { ...left, branch: leftCommit };
  const rightSource: GitSource = { ...right, branch: rightCommit };
  // Identical content still asks both sides' blame, so the lines whose last change differs can be marked.
  const isIdentical = identicalPanes !== undefined;
  const blameLeft = useQuery({
    ...blameQuery(user, sessionId, leftSource, target.leftPath ?? ''),
    enabled: (blamed.has('left') || isIdentical) && target.leftPath !== undefined,
  });
  const blameRight = useQuery({
    ...blameQuery(user, sessionId, rightSource, target.rightPath ?? ''),
    enabled: (blamed.has('right') || isIdentical) && target.rightPath !== undefined,
  });
  const leftCommits = commitsOf(blameLeft.data);
  const rightCommits = commitsOf(blameRight.data);
  // Shared (dashed) commits are only needed where a side's blame is shown.
  const leftShared = useQuery({
    ...ancestryQuery(user, sessionId, rightSource, leftCommits),
    enabled: leftCommits.length > 0 && blamed.has('left'),
  });
  const rightShared = useQuery({
    ...ancestryQuery(user, sessionId, leftSource, rightCommits),
    enabled: rightCommits.length > 0 && blamed.has('right'),
  });
  // Lines of identical content whose last change is a different commit on each side.
  const differingLines =
    isIdentical && blameLeft.data !== undefined && blameRight.data !== undefined
      ? differingLinesOf(blameLeft.data, blameRight.data)
      : undefined;
  // A blamed side keeps its column while its blame loads, so the layout does not jump.
  const blame =
    blamed.size === 0
      ? undefined
      : {
          ...(blamed.has('left') ? { left: marksOf(blameLeft.data, leftShared.data) } : {}),
          ...(blamed.has('right') ? { right: marksOf(blameRight.data, rightShared.data) } : {}),
        };

  // The originating Folder Compare, if this browser tab has it: labels and previous/next.
  // Never run here; a file tab should not start a whole folder comparison.
  const folder = useQuery({
    ...folderCompareQuery(user, sessionId, left, right),
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
        <h1 className="min-w-0 font-mono font-medium">
          <FullText text={path} className="font-mono font-medium" />
        </h1>
        <span className="rounded bg-hover px-1.5 text-xs text-muted">{statusOf(target, diff)}</span>
        <div className="ml-auto">
          <Toolbar
            items={[
              ...(index >= 0
                ? [
                    {
                      key: 'prev',
                      priority: 'primary' as const,
                      node: (
                        <button
                          type="button"
                          aria-label="Previous difference"
                          title="Previous differing file"
                          disabled={index <= 0}
                          className="touch-target rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
                          onClick={() => {
                            const prev = differences[index - 1];
                            if (prev) {
                              workspace.open(
                                fileTab(prev, { explain: isExplaining ? '1' : undefined }),
                                {
                                  isExact: true,
                                  isReplacing: true,
                                },
                              );
                            }
                          }}
                        >
                          <ChevronLeft className="size-4" aria-hidden />
                        </button>
                      ),
                    },
                    {
                      key: 'count',
                      priority: 'primary' as const,
                      node: (
                        <span className="text-xs tabular-nums text-muted">
                          {index + 1} / {differences.length}
                        </span>
                      ),
                    },
                    {
                      key: 'next',
                      priority: 'primary' as const,
                      node: (
                        <button
                          type="button"
                          aria-label="Next difference"
                          title="Next differing file"
                          disabled={index >= differences.length - 1}
                          className="touch-target rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
                          onClick={() => {
                            const next = differences[index + 1];
                            if (next) {
                              workspace.open(
                                fileTab(next, { explain: isExplaining ? '1' : undefined }),
                                {
                                  isExact: true,
                                  isReplacing: true,
                                },
                              );
                            }
                          }}
                        >
                          <ChevronRight className="size-4" aria-hidden />
                        </button>
                      ),
                    },
                  ]
                : []),
              {
                key: 'whole',
                priority: 'secondary',
                node: (
                  <button
                    type="button"
                    aria-pressed={isFullFile}
                    className={clsx(
                      'touch-target flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
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
                ),
              },
              ...(['left', 'right'] as const).map((side) => {
                const isBlamed = blamed.has(side);
                const hasFile =
                  (side === 'left' ? target.leftPath : target.rightPath) !== undefined;
                const sideName = side === 'left' ? 'Left' : 'Right';
                return {
                  key: `blame-${side}`,
                  priority: 'secondary' as const,
                  node: (
                    <button
                      type="button"
                      aria-pressed={isBlamed}
                      disabled={!hasFile}
                      title={
                        hasFile
                          ? `Show the last change to each line in ${sideName}'s history`
                          : `This file is not on the ${sideName} side`
                      }
                      className={clsx(
                        'touch-target flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs disabled:opacity-40',
                        isBlamed
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-line hover:bg-hover',
                      )}
                      onClick={() => {
                        // Toggle this side; the other side keeps its choice.
                        const next = (['left', 'right'] as const).filter((s) =>
                          s === side ? !isBlamed : blamed.has(s),
                        );
                        setSearch({ blame: next.length === 0 ? undefined : next.join(',') }, true);
                      }}
                    >
                      <History className="size-3.5" aria-hidden /> Blame {sideName}
                    </button>
                  ),
                };
              }),
              ...(['left', 'right'] as const).map((side) => ({
                key: `commits-${side}`,
                priority: 'secondary' as const,
                node: (
                  <button
                    type="button"
                    title={`Commits that ${side === 'left' ? 'Left' : 'Right'} has and the other side does not, in a new tab`}
                    className="touch-target flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
                    onClick={() => {
                      // This side's commit, without what the other side's commit already has.
                      const mine =
                        side === 'left'
                          ? { ...left, branch: leftCommit }
                          : { ...right, branch: rightCommit };
                      const other =
                        side === 'left'
                          ? { ...right, branch: rightCommit }
                          : { ...left, branch: leftCommit };
                      workspace.open(commitsUrl(user, sessionId, mine, { notIn: other }));
                    }}
                  >
                    <GitCommitHorizontal className="size-3.5" aria-hidden />
                    {side === 'left' ? 'Left' : 'Right'}: diverging commits
                  </button>
                ),
              })),
              ...(diff?.content === 'text'
                ? [
                    {
                      key: 'explain',
                      priority: 'secondary' as const,
                      node: (
                        <button
                          type="button"
                          aria-pressed={isExplaining}
                          title="Find the commits that account for these changes"
                          className={clsx(
                            'touch-target flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
                            isExplaining
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-line hover:bg-hover',
                          )}
                          onClick={() => {
                            setSearch(
                              isExplaining
                                ? { explain: undefined, commit: undefined }
                                : { explain: '1' },
                            );
                          }}
                        >
                          <GitCommitHorizontal className="size-3.5" aria-hidden /> Explain
                          difference
                        </button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>

      {blamed.size > 0 && (
        <p className="border-b border-line bg-surface px-4 py-1 text-xs text-muted">
          Blame shows the last change to each line in that side’s history. It is not necessarily
          what caused the difference. A dashed commit is in both sides’ history.
        </p>
      )}

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
          ) : diff.content === 'text' || identicalPanes !== undefined ? (
            <SnapshotDiffView
              diff={identicalPanes ?? diff}
              differingLines={identicalPanes === undefined ? undefined : differingLines}
              leftLabel={leftLabel}
              rightLabel={rightLabel}
              focusedHunk={focusedHunk}
              focusedLine={focusedLine}
              highlightCommit={commitSha}
              tokens={highlight.data ?? undefined}
              blame={blame}
              layout={layout}
              onLayoutChange={(next) => {
                setSearch({ view: next }, true);
              }}
              wrap={isWrapping}
              onWrapChange={(next) => {
                setSearch({ wrap: next ? undefined : '0' }, true);
              }}
              onFocusHunk={(h) => {
                if (h !== focusedHunk) setSearch({ hunk: String(h) }, true);
              }}
              onFocusLine={setFocusedLine}
              onOpenCommit={(sha, side) => {
                // The commit lives in the repository of the side whose history it is in.
                workspace.open(
                  commitUrl(user, sessionId, side === 'left' ? left.repoId : right.repoId, sha),
                );
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
            onOpenCommit={(sha) => {
              // The commit is opened from the repository of the side whose history holds it.
              const found = explained.data?.commits.find((c) => c.sha === sha);
              const repoId =
                found?.inRight === true && found.inLeft !== true ? right.repoId : left.repoId;
              workspace.open(commitUrl(user, sessionId, repoId, sha));
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
  onOpenCommit,
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
  onOpenCommit: (sha: string) => void;
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
        label: `${line.kind === 'removed' ? `Left line ${line.leftLine ?? ''}` : `Right line ${line.rightLine ?? ''}`} · ${target.key}`,
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
    <Sheet title="Explanation" onClose={onClose}>
      <AttributionPanel
        scope={scope}
        attribution={attribution}
        error={note}
        selected={selected}
        footprint={footprint}
        analyzedFiles={analyzedFiles}
        onSelectCommit={onSelectCommit}
        onOpenFile={onOpenFile}
        commitActions={
          selected === undefined ? undefined : (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-ink hover:bg-hover"
              onClick={() => {
                onOpenCommit(selected.sha);
              }}
            >
              <GitCommitHorizontal className="size-4" aria-hidden />
              Open commit in a new tab
            </button>
          )
        }
        onClose={onClose}
      />
    </Sheet>
  );
}
