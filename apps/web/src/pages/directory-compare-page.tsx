import type {
  CompareNode,
  CompareSummary,
  DirectoryCompareResult,
  GitSource,
  SnapshotFileDiff,
  Source,
} from '@om/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Home,
  LoaderCircle,
  RefreshCw,
  Rows3,
  Search,
} from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  AttributionPanel,
  type AttributionProgress,
  type AttributionScope,
} from '../components/attribution-panel.tsx';
import { CompareTree } from '../components/compare-tree.tsx';
import { SnapshotDiffView, type LineRef } from '../components/snapshot-diff-view.tsx';
import { CompareForm } from '../components/compare-form.tsx';
import { compareDirectories, getDefaults } from '../lib/api.ts';
import {
  commitFootprint,
  diffTarget,
  differingFiles,
  shortSha,
  summarizeAttribution,
  type AttributionInput,
  type CommitFootprint,
  type DiffTarget,
  type ScopeAttribution,
} from '../lib/attribution.ts';
import { sessionKey, useSessionDetail, useSessionParams } from '../lib/session.ts';
import {
  fileDiffQuery,
  useAnalyzedDiffs,
  useDirectoryAttribution,
  type SnapshotPair,
} from '../lib/snapshot-diff.ts';
import { sourceFromParams, sourcesSearch } from '../lib/sources.ts';
import { sessionPath } from '../lib/urls.ts';
import {
  breadcrumbs,
  collectDirectoryPaths,
  findEntry,
  findNode,
  flattenTree,
  isDirectory,
  joinPath,
  rowKey,
  type TreeFilter,
} from '../lib/tree.ts';

const chips: Array<{ key: keyof CompareSummary; filter: TreeFilter; label: string; dot: string }> =
  [
    { key: 'identical', filter: 'identical', label: 'Identical', dot: 'bg-muted' },
    { key: 'modified', filter: 'modified', label: 'Different', dot: 'bg-modified-dot' },
    { key: 'onlyLeft', filter: 'only-left', label: 'Only in base', dot: 'bg-left-dot' },
    { key: 'onlyRight', filter: 'only-right', label: 'Only in target', dot: 'bg-right-dot' },
    { key: 'errors', filter: 'error', label: 'Errors', dot: 'bg-error-dot' },
  ];

/** Search string with `changes` applied (undefined/empty deletes the key). */
function withParams(params: URLSearchParams, changes: Record<string, string | undefined>): string {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined && value !== '') next.set(key, value);
    else next.delete(key);
  }
  return `?${next}`;
}

/** Folders: pick Base and Target and browse the comparison tree. All state lives in the URL. */
export function DirectoryComparePage(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const left = sourceFromParams(params, 'left');
  const right = sourceFromParams(params, 'right');
  const key = JSON.stringify([left, right]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-surface px-4 py-3">
        <CompareForm
          key={key}
          initialLeft={left}
          initialRight={right}
          repos={session.data?.repos ?? []}
          user={user}
          sessionId={sessionId}
          onSubmit={(l, r) => {
            void navigate({ search: sourcesSearch(l, r) });
          }}
        />
      </div>
      {left && right ? (
        <Comparison key={key} left={left} right={right} user={user} sessionId={sessionId} />
      ) : !left && !right ? (
        <DefaultFolders />
      ) : (
        <EmptyHint />
      )}
    </div>
  );
}

function EmptyHint() {
  return (
    <p className="m-auto p-8 text-center text-muted">
      Enter two folder paths to compare their contents byte by byte.
    </p>
  );
}

/** With no folders in the URL, open the server's default folders (the repo examples). */
function DefaultFolders() {
  const query = useQuery({ queryKey: ['defaults'], queryFn: getDefaults, staleTime: Infinity });
  if (query.isPending) return null;
  const { left, right } = query.data ?? {};
  if (left !== undefined && left !== '' && right !== undefined && right !== '') {
    return <Navigate replace to={{ search: `?${new URLSearchParams({ left, right })}` }} />;
  }
  return <EmptyHint />;
}

type ComparisonProps = {
  left: Source;
  right: Source;
  user: string;
  sessionId: string;
};

/** Folders with at most this many differing files are attributed as soon as they're focused. */
const AUTO_ATTRIBUTE_FILES = 40;

const NO_GIT: GitSource = { type: 'git', repoId: '', branch: '' };
const NO_PAIR: SnapshotPair = { user: '', sessionId: '', left: NO_GIT, right: NO_GIT };
const NO_TARGET: DiffTarget = { key: '' };

const contentNotice = {
  identical: 'Same content on both sides (a rename without changes): nothing to attribute.',
  binary: 'Binary file: git has no lines to attribute.',
  'too-large': 'Too large to diff as text, so no line attribution.',
} as const;

const nonEmpty = (value: string | null): string | undefined =>
  value === null || value === '' ? undefined : value;

/**
 * Both sides as git snapshots pinned to the commits the comparison resolved, so every later
 * analysis (diffs, blame) describes exactly the trees on screen, even after a fetch.
 */
function snapshotPair(
  left: Source,
  right: Source,
  data: DirectoryCompareResult | undefined,
  user: string,
  sessionId: string,
): SnapshotPair | undefined {
  if (left.type !== 'git' || right.type !== 'git' || !data?.leftSnapshot || !data.rightSnapshot) {
    return undefined;
  }
  return {
    user,
    sessionId,
    left: { ...left, branch: data.leftSnapshot.commit },
    right: { ...right, branch: data.rightSnapshot.commit },
  };
}

/** Files (both ends of renames) and their folders where the selected commit accounts for lines. */
function highlightPaths(footprint: CommitFootprint, analyzed: AttributionInput): Set<string> {
  const paths = new Set<string>();
  const keys = new Set(footprint.map((f) => f.key));
  for (const { key, diff } of analyzed) {
    if (!keys.has(key)) continue;
    for (const p of [diff.leftPath, diff.rightPath]) {
      if (p === undefined) continue;
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
    }
  }
  return paths;
}

function Comparison({ left, right, user, sessionId }: ComparisonProps) {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const path = params.get('path') ?? '';
  const openPath = nonEmpty(params.get('file'));
  const commitSha = nonEmpty(params.get('commit'));
  const hunkParam = params.get('hunk');
  const focusedHunk = hunkParam !== null && /^\d+$/.test(hunkParam) ? Number(hunkParam) : undefined;
  const isFullFile = params.get('full') === '1';

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<TreeFilter>('all');
  const [selected, setSelected] = useState<CompareNode>();
  const [focusKey, setFocusKey] = useState<string>();
  const [focusedLine, setFocusedLine] = useState<LineRef>();
  const [startedFolders, setStartedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [searchFolder, setSearchFolder] = useState<string>();

  const query = useQuery({
    queryKey: ['compare-directories', user, sessionId, left, right],
    queryFn: async () => {
      const result = await compareDirectories({ left, right, user, sessionId });
      // The comparison is now in the session's recent list.
      void queryClient.invalidateQueries({ queryKey: sessionKey(user, sessionId) });
      return result;
    },
    staleTime: Infinity,
  });

  const data = query.data;
  const pair = useMemo(
    () => snapshotPair(left, right, data, user, sessionId),
    [left, right, data, user, sessionId],
  );
  const current = data ? findNode(data.root, path) : undefined;
  const rows = current && isDirectory(current) ? flattenTree(current, expanded, filter) : [];
  const openNode = data && openPath !== undefined ? findEntry(data.root, openPath) : undefined;
  const focusNode =
    focusKey === undefined ? undefined : rows.find((r) => rowKey(r.node) === focusKey)?.node;

  // Attribution follows focus: the open file, else the focused row, else the current folder.
  const scopeDir =
    openNode === undefined
      ? focusNode && isDirectory(focusNode)
        ? focusNode
        : focusNode === undefined && current && isDirectory(current)
          ? current
          : undefined
      : undefined;
  // Not memoized: the hook keys its work on the target paths, not on array identity.
  const dirTargets = scopeDir ? differingFiles(scopeDir) : [];
  const isDirStarted =
    scopeDir !== undefined &&
    (dirTargets.length <= AUTO_ATTRIBUTE_FILES || startedFolders.has(scopeDir.path));
  const dirAttribution = useDirectoryAttribution(pair, dirTargets, isDirStarted);

  const searchTargets = useMemo(() => {
    if (searchFolder === undefined || !data) return [];
    return differingFiles(findNode(data.root, searchFolder) ?? data.root);
  }, [searchFolder, data]);
  const search = useDirectoryAttribution(pair, searchTargets, searchFolder !== undefined);

  const fileNode = openNode ?? (focusNode && !isDirectory(focusNode) ? focusNode : undefined);
  const fileTarget = fileNode ? diffTarget(fileNode) : undefined;
  const isFileDiffable =
    fileNode !== undefined && fileNode.status !== 'identical' && fileNode.status !== 'error';
  const fileQuery = useQuery({
    ...fileDiffQuery(
      pair ?? NO_PAIR,
      fileTarget ?? NO_TARGET,
      openNode !== undefined && isFullFile,
    ),
    enabled: pair !== undefined && fileTarget !== undefined && isFileDiffable,
  });

  const analyzed = useAnalyzedDiffs(pair);
  const selectedCommit =
    commitSha === undefined
      ? undefined
      : [...(fileQuery.data?.commits ?? []), ...analyzed.flatMap((e) => e.diff.commits)].find(
          (c) => c.sha === commitSha,
        );
  const footprint = useMemo(
    () => (commitSha === undefined ? [] : commitFootprint(commitSha, analyzed)),
    [commitSha, analyzed],
  );
  const highlighted = useMemo(() => highlightPaths(footprint, analyzed), [footprint, analyzed]);

  const setSearch = (changes: Record<string, string | undefined>, shouldReplace = false) => {
    void navigate({ search: withParams(params, changes) }, { replace: shouldReplace });
  };

  const goTo = (p: string) => {
    setSearch({ path: p, file: undefined, hunk: undefined });
  };

  const openFiles = (l: string | undefined, r: string | undefined) => {
    const search = new URLSearchParams();
    if (l !== undefined && l !== '') search.set('left', l);
    if (r !== undefined && r !== '') search.set('right', r);
    search.set('from', location.pathname + location.search);
    void navigate(`${sessionPath(user, sessionId, 'files')}?${search}`);
  };

  const absolute = (node: CompareNode, side: 'left' | 'right') =>
    node[side] && data ? joinPath(data[side], node.path) : undefined;

  const openFile = (key: string, hunk?: number) => {
    setFocusedLine(undefined);
    setSearch({ file: key, hunk: hunk === undefined ? undefined : String(hunk) });
  };

  const open = (node: CompareNode) => {
    if (isDirectory(node)) goTo(node.path);
    else if (pair) openFile(node.path);
    else openFiles(absolute(node, 'left'), absolute(node, 'right'));
  };

  const toggle = (node: CompareNode) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  if (query.isPending) {
    return <p className="m-auto p-8 text-muted">Comparing…</p>;
  }
  if (query.isError) {
    return (
      <div
        role="alert"
        className="m-4 rounded-md border border-error/40 bg-error-soft p-4 text-error"
      >
        {query.error.message}
      </div>
    );
  }

  const { summary } = query.data;
  const crumbs = breadcrumbs(openNode ? openNode.path.split('/').slice(0, -1).join('/') : path);

  // What the attribution panel explains.
  let scope: AttributionScope = { kind: 'Repository', label: '/' };
  let attribution: ScopeAttribution | undefined;
  let notice: string | undefined;
  let error: string | undefined;
  let progress: AttributionProgress | undefined;
  let onStart: (() => void) | undefined;
  if (fileNode && fileTarget) {
    scope = { kind: 'File', label: fileNode.path };
    const diff = fileQuery.data;
    if (!isFileDiffable) {
      notice =
        fileNode.status === 'identical'
          ? 'Identical in both snapshots: nothing to attribute.'
          : 'This entry could not be read.';
    } else if (fileQuery.isError) error = fileQuery.error.message;
    else if (diff && diff.content !== 'text') notice = contentNotice[diff.content];
    else if (diff) {
      const line =
        openNode && focusedLine ? diff.hunks[focusedLine.hunk]?.lines[focusedLine.line] : undefined;
      const hunk = openNode && focusedHunk !== undefined ? diff.hunks[focusedHunk] : undefined;
      if (line && hunk) {
        scope = {
          kind: 'Line',
          label: `${line.kind === 'removed' ? `Base line ${line.leftLine ?? ''}` : `Target line ${line.rightLine ?? ''}`} · ${fileNode.path}`,
        };
        attribution = summarizeAttribution([
          { key: fileTarget.key, diff, hunks: [{ ...hunk, lines: [line] }] },
        ]);
      } else if (hunk && focusedHunk !== undefined) {
        scope = {
          kind: 'Hunk',
          label: `${focusedHunk + 1} of ${diff.hunks.length} · ${fileNode.path}`,
        };
        attribution = summarizeAttribution([{ key: fileTarget.key, diff, hunks: [hunk] }]);
      } else {
        attribution = summarizeAttribution([{ key: fileTarget.key, diff }]);
      }
      if (diff.attributionNote !== undefined && attribution.shares.length === 0) {
        error = diff.attributionNote;
      }
    }
  } else if (scopeDir) {
    scope =
      scopeDir.path === ''
        ? { kind: 'Repository', label: '/' }
        : { kind: 'Folder', label: `${scopeDir.path}/` };
    progress = {
      done: dirAttribution.done,
      total: dirAttribution.total,
      isRunning: dirAttribution.isRunning,
      errors: dirAttribution.errors.length,
    };
    if (dirTargets.length === 0) notice = 'No differences in this folder.';
    else if (!isDirStarted) {
      onStart = () => {
        setStartedFolders((prev) => new Set(prev).add(scopeDir.path));
      };
    } else if (dirAttribution.results.length > 0 || !dirAttribution.isRunning) {
      attribution = summarizeAttribution(dirAttribution.results);
    }
  }

  const searchScope = path;
  const isSearchDone = searchFolder === searchScope && search.total > 0 && !search.isRunning;
  const commitActions =
    selectedCommit === undefined ? undefined : (
      <button
        type="button"
        disabled={search.isRunning || isSearchDone}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-60"
        onClick={() => {
          setSearchFolder(searchScope);
        }}
      >
        {search.isRunning ? (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Search className="size-3.5" aria-hidden />
        )}
        {search.isRunning
          ? `Searching ${search.done} of ${search.total} files…`
          : isSearchDone
            ? `Searched every difference under ${searchScope === '' ? '/' : `${searchScope}/`}`
            : `Search every difference under ${searchScope === '' ? '/' : `${searchScope}/`}`}
      </button>
    );

  const allDifferences = differingFiles(query.data.root);
  const openIndex = openNode ? allDifferences.findIndex((t) => t.key === fileTarget?.key) : -1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2 text-sm">
        <div role="group" aria-label="Summary" className="flex flex-wrap gap-1">
          {chips.map((chip) =>
            chip.key === 'errors' && summary.errors === 0 ? null : (
              <button
                key={chip.key}
                type="button"
                aria-pressed={filter === chip.filter}
                title={`Filter to: ${chip.label}`}
                onClick={() => {
                  setFilter(filter === chip.filter ? 'all' : chip.filter);
                }}
                className={clsx(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
                  filter === chip.filter
                    ? 'border-accent bg-accent-soft'
                    : 'border-line hover:bg-hover',
                )}
              >
                <span className={clsx('size-2 rounded-full', chip.dot)} aria-hidden />
                {chip.label} <span className="font-semibold tabular-nums">{summary[chip.key]}</span>
              </button>
            ),
          )}
        </div>
        <div
          role="radiogroup"
          aria-label="Show"
          className="flex overflow-hidden rounded-md border border-line"
        >
          {(['all', 'differences'] as const).map((f) => (
            <label
              key={f}
              className={clsx(
                'cursor-pointer px-2.5 py-0.5',
                filter === f ? 'bg-accent-soft text-accent' : 'hover:bg-hover',
              )}
            >
              <input
                type="radio"
                name="filter"
                className="sr-only"
                checked={filter === f}
                onChange={() => {
                  setFilter(f);
                }}
              />
              {f === 'all' ? 'All' : 'Differences only'}
            </label>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {current && !openNode && (
            <>
              <button
                type="button"
                className="rounded px-2 py-0.5 text-muted hover:bg-hover"
                onClick={() => {
                  setExpanded(new Set(collectDirectoryPaths(current)));
                }}
              >
                Expand all
              </button>
              <button
                type="button"
                className="rounded px-2 py-0.5 text-muted hover:bg-hover"
                onClick={() => {
                  setExpanded(new Set());
                }}
              >
                Collapse all
              </button>
            </>
          )}
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-hover disabled:opacity-50"
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            <RefreshCw
              className={clsx('size-3.5', query.isFetching && 'animate-spin')}
              aria-hidden
            />
            Rescan
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-1.5 text-sm">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1">
            {crumbs.map((crumb, i) => {
              const isLast = i === crumbs.length - 1 && !openNode;
              const label =
                crumb.path === '' ? (
                  <span className="flex items-center gap-1">
                    <Home className="size-3.5" aria-hidden />
                    root
                  </span>
                ) : (
                  crumb.name
                );
              return (
                <li key={crumb.path} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3.5 text-muted" aria-hidden />}
                  {isLast ? (
                    <span aria-current="page" className="font-medium">
                      {label}
                    </span>
                  ) : (
                    <Link
                      to={{
                        search: withParams(params, {
                          path: crumb.path,
                          file: undefined,
                          hunk: undefined,
                        }),
                      }}
                      className="text-accent hover:underline"
                    >
                      {label}
                    </Link>
                  )}
                </li>
              );
            })}
            {openNode && (
              <li className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-muted" aria-hidden />
                <span aria-current="page" className="font-mono font-medium">
                  {openNode.name}
                </span>
              </li>
            )}
          </ol>
        </nav>
        <Legend />
      </div>

      {selected && (
        <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-4 py-1 text-sm">
          <span className="font-mono">{`Selected: ${selected.path}`}</span>
          <span className="text-muted">
            — choose another file and click “Compare with selected”.
          </span>
          <button
            type="button"
            className="ml-auto text-accent hover:underline"
            onClick={() => {
              setSelected(undefined);
            }}
          >
            Clear
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {openNode && pair ? (
            <FileView
              node={openNode}
              diffQuery={fileQuery}
              leftLabel={`${query.data.leftLabel}${pair.left.branch ? ` (${shortSha(pair.left.branch)})` : ''}`}
              rightLabel={`${query.data.rightLabel}${pair.right.branch ? ` (${shortSha(pair.right.branch)})` : ''}`}
              isFullFile={isFullFile}
              focusedHunk={focusedHunk}
              focusedLine={focusedLine}
              highlightCommit={commitSha}
              position={{ index: openIndex, total: allDifferences.length }}
              onBack={() => {
                setFocusedLine(undefined);
                setSearch({ file: undefined, hunk: undefined });
              }}
              onStep={(delta) => {
                const next = allDifferences[openIndex + delta];
                if (next) openFile(next.key);
              }}
              onToggleFull={() => {
                setSearch({ full: isFullFile ? undefined : '1', hunk: undefined }, true);
                setFocusedLine(undefined);
              }}
              onOpenEditor={() => {
                openFiles(
                  fileTarget?.leftPath === undefined
                    ? undefined
                    : joinPath(query.data.left, fileTarget.leftPath),
                  fileTarget?.rightPath === undefined
                    ? undefined
                    : joinPath(query.data.right, fileTarget.rightPath),
                );
              }}
              onFocusHunk={(h) => {
                if (h !== focusedHunk) setSearch({ hunk: String(h) }, true);
              }}
              onFocusLine={setFocusedLine}
              onSelectCommit={(sha) => {
                setSearch({ commit: sha });
              }}
            />
          ) : (
            openPath !== undefined &&
            pair && (
              <p className="p-8 text-center text-muted">
                File <span className="font-mono">“{openPath}”</span> is not part of this comparison.
              </p>
            )
          )}
          <div
            className={clsx(
              'flex min-h-0 flex-1 flex-col',
              openPath !== undefined && pair && 'hidden',
            )}
          >
            <div
              data-testid="column-labels"
              className="grid grid-cols-2 border-b border-line bg-surface text-xs font-medium text-muted"
            >
              {(['left', 'right'] as const).map((side) => {
                const label = side === 'left' ? query.data.leftLabel : query.data.rightLabel;
                const snapshot =
                  side === 'left' ? query.data.leftSnapshot : query.data.rightSnapshot;
                return (
                  <div
                    key={side}
                    className={clsx(
                      'flex min-w-0 gap-1 px-3 py-1 font-mono',
                      side === 'right' && 'border-l border-line',
                    )}
                    title={
                      snapshot ? `${label} = ${snapshot.commit}` : joinPath(query.data[side], path)
                    }
                  >
                    <span className="truncate">{label}</span>
                    {snapshot && (
                      <span className="shrink-0 text-muted/80">{shortSha(snapshot.commit)}</span>
                    )}
                    {path && <span className="shrink-0 text-muted/80">/ {path}</span>}
                  </div>
                );
              })}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {current && isDirectory(current) ? (
                <CompareTree
                  rows={rows}
                  selected={selected}
                  onToggle={toggle}
                  onOpen={open}
                  onSelect={setSelected}
                  onFocusRow={(node) => {
                    setFocusKey(rowKey(node));
                  }}
                  highlighted={highlighted}
                  onCompareWithSelected={(node) => {
                    if (!selected) return;
                    openFiles(
                      absolute(selected, 'left') ?? absolute(selected, 'right'),
                      absolute(node, 'right') ?? absolute(node, 'left'),
                    );
                  }}
                />
              ) : (
                <div className="p-8 text-center text-muted">
                  <p className="mb-2">
                    Folder <span className="font-mono">“{path}”</span> was not found in this
                    comparison.
                  </p>
                  <Link
                    to={{ search: withParams(params, { path: undefined }) }}
                    className="text-accent underline"
                  >
                    Go to root
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>

        {pair && (
          <AttributionPanel
            scope={scope}
            attribution={attribution}
            progress={progress}
            notice={notice}
            onStart={onStart}
            error={error}
            selected={selectedCommit}
            footprint={footprint}
            analyzedFiles={analyzed.length}
            onSelectCommit={(sha) => {
              setSearch({ commit: sha });
            }}
            onOpenFile={openFile}
            commitActions={commitActions}
          />
        )}
      </div>
    </div>
  );
}

type FileViewProps = {
  node: CompareNode;
  diffQuery: UseQueryResult<SnapshotFileDiff>;
  leftLabel: string;
  rightLabel: string;
  isFullFile: boolean;
  focusedHunk: number | undefined;
  focusedLine: LineRef | undefined;
  highlightCommit: string | undefined;
  /** Index of this file among all differences, for previous/next. */
  position: { index: number; total: number };
  onBack: () => void;
  onStep: (delta: number) => void;
  onToggleFull: () => void;
  onOpenEditor: () => void;
  onFocusHunk: (hunk: number) => void;
  onFocusLine: (line: LineRef | undefined) => void;
  onSelectCommit: (sha: string) => void;
};

/** One file of a git comparison: git's hunks with attribution, inside the folder view. */
function FileView({
  node,
  diffQuery,
  leftLabel,
  rightLabel,
  isFullFile,
  focusedHunk,
  focusedLine,
  highlightCommit,
  position,
  onBack,
  onStep,
  onToggleFull,
  onOpenEditor,
  onFocusHunk,
  onFocusLine,
  onSelectCommit,
}: FileViewProps) {
  const statusText: Record<CompareNode['status'], string> = {
    identical: 'Identical',
    modified: 'Different',
    'only-left': node.renamedTo === undefined ? 'Only in base' : 'Renamed',
    'only-right': node.renamedFrom === undefined ? 'Only in target' : 'Renamed',
    error: 'Error',
  };
  const diff = diffQuery.data;
  return (
    <section aria-label={`File ${node.path}`} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-1.5 text-sm">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-hover"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" aria-hidden /> Folder
        </button>
        <span className="min-w-0 truncate font-mono font-medium" title={node.path}>
          {node.path}
        </span>
        <span className="rounded bg-hover px-1.5 text-xs text-muted">
          {statusText[node.status]}
        </span>
        {(node.renamedTo ?? node.renamedFrom) !== undefined && (
          <span className="text-xs text-muted">
            {node.renamedTo === undefined
              ? `from ${node.renamedFrom ?? ''}`
              : `→ ${node.renamedTo}`}
            {node.similarity === undefined ? '' : ` (${node.similarity}% similar)`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous difference"
            title="Previous differing file"
            disabled={position.index <= 0}
            className="rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
            onClick={() => {
              onStep(-1);
            }}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="text-xs tabular-nums text-muted">
            {position.index >= 0 ? `${position.index + 1} / ${position.total}` : ''}
          </span>
          <button
            type="button"
            aria-label="Next difference"
            title="Next differing file"
            disabled={position.index < 0 || position.index >= position.total - 1}
            className="rounded p-1 text-muted hover:bg-hover disabled:opacity-40"
            onClick={() => {
              onStep(1);
            }}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-pressed={isFullFile}
            className={clsx(
              'flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
              isFullFile
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line hover:bg-hover',
            )}
            onClick={onToggleFull}
          >
            <Rows3 className="size-3.5" aria-hidden /> Whole file
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
            title="Side-by-side, syntax-highlighted editor diff of the checked-out files"
            onClick={onOpenEditor}
          >
            <FileCode2 className="size-3.5" aria-hidden /> Open in editor
          </button>
        </div>
      </div>
      {node.status === 'identical' ? (
        <p className="m-auto p-8 text-muted">This file is identical in both snapshots.</p>
      ) : diffQuery.isError ? (
        <div
          role="alert"
          className="m-4 rounded-md border border-error/40 bg-error-soft p-4 text-error"
        >
          {diffQuery.error.message}
        </div>
      ) : !diff ? (
        <p className="m-auto flex items-center gap-2 p-8 text-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Diffing and attributing…
        </p>
      ) : diff.content === 'text' ? (
        <SnapshotDiffView
          diff={diff}
          leftLabel={leftLabel}
          rightLabel={rightLabel}
          focusedHunk={focusedHunk}
          focusedLine={focusedLine}
          highlightCommit={highlightCommit}
          onFocusHunk={onFocusHunk}
          onFocusLine={onFocusLine}
          onSelectCommit={onSelectCommit}
        />
      ) : (
        <p className="m-auto max-w-md p-8 text-center text-muted">{contentNotice[diff.content]}</p>
      )}
    </section>
  );
}

function Legend() {
  const items = [
    ['bg-left-dot', 'Only in base'],
    ['bg-right-dot', 'Only in target'],
    ['bg-modified-dot', 'Different'],
  ] as const;
  return (
    <ul className="flex gap-3 text-xs text-muted" aria-label="Legend">
      {items.map(([dot, label]) => (
        <li key={label} className="flex items-center gap-1">
          <span className={clsx('size-2.5 rounded-sm', dot)} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}
