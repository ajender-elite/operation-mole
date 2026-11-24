import type { CompareNode, CompareSummary, FolderComparison, GitSource } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ChevronRight,
  GitCommitHorizontal,
  Home,
  LoaderCircle,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  AttributionPanel,
  type AttributionProgress,
  type AttributionScope,
} from '../components/attribution-panel.tsx';
import { CompareForm } from '../components/compare-form.tsx';
import { Toolbar } from '../components/toolbar.tsx';
import { Sheet } from '../components/sheet.tsx';
import { CompareTree } from '../components/compare-tree.tsx';
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
import { folderCompareQuery } from '../lib/folder-compare.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import {
  fileDiffQuery,
  useAnalyzedDiffs,
  useDirectoryAttribution,
  type SnapshotPair,
} from '../lib/snapshot-diff.ts';
import { sourceFromParams, sourceLabel } from '../lib/sources.ts';
import { fileUrl, foldersUrl, sessionPath } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';
import {
  breadcrumbs,
  collectDirectoryPaths,
  findEntry,
  findNode,
  flattenTree,
  countUnder,
  isDirectory,
  type TreeFilter,
} from '../lib/tree.ts';

const chips: Array<{ key: keyof CompareSummary; filter: TreeFilter; label: string; dot: string }> =
  [
    { key: 'identical', filter: 'identical', label: 'Identical', dot: 'bg-muted' },
    { key: 'modified', filter: 'modified', label: 'Different', dot: 'bg-modified-dot' },
    { key: 'onlyLeft', filter: 'only-left', label: 'Only in left', dot: 'bg-side-left-dot' },
    { key: 'onlyRight', filter: 'only-right', label: 'Only in right', dot: 'bg-side-right-dot' },
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

/** Old `/files` links: open Folder Compare with the same query. */
export function FilesRedirect(): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const location = useLocation();
  return <Navigate replace to={`${sessionPath(user, sessionId, 'folders')}${location.search}`} />;
}

/**
 * Folder Compare: what is different between two git snapshots, as a tree. Files open in their
 * own File Compare tab; what accounts for a difference is shown only when asked. All state
 * lives in the URL.
 */
export function DirectoryComparePage(): JSX.Element {
  const [params] = useSearchParams();
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const workspace = useWorkspace();
  const left = sourceFromParams(params, 'left');
  const right = sourceFromParams(params, 'right');
  const key = JSON.stringify([left, right]);
  const repos = session.data?.repos ?? [];

  const form = (
    <CompareForm
      key={key}
      initialLeft={left}
      initialRight={right}
      repos={repos}
      user={user}
      sessionId={sessionId}
      onSubmit={(l, r) => {
        // A different pair is a different context: it takes this tab's place.
        workspace.open(foldersUrl(user, sessionId, l, r), { isReplacing: true });
      }}
    />
  );

  if (!left || !right) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-line bg-surface px-4 py-3">{form}</div>
        <p className="m-auto p-8 text-center text-muted">
          Choose a repository and a branch for both sides to compare their folders.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-1.5 text-sm short:py-1">
        <span className="min-w-0 truncate">
          <span className="text-muted">Left</span>{' '}
          <span className="font-mono">{sourceLabel(left, repos)}</span>
          <span className="px-2 text-muted">↔</span>
          <span className="text-muted">Right</span>{' '}
          <span className="font-mono">{sourceLabel(right, repos)}</span>
        </span>
      </div>
      <Comparison key={key} left={left} right={right} user={user} sessionId={sessionId} />
    </div>
  );
}

type ComparisonProps = {
  left: GitSource;
  right: GitSource;
  user: string;
  sessionId: string;
};

/** An explained folder with at most this many differing files is attributed right away. */
const AUTO_ATTRIBUTE_FILES = 40;

const NO_GIT: GitSource = { type: 'git', repoId: '', branch: '' };
const NO_PAIR: SnapshotPair = { user: '', sessionId: '', left: NO_GIT, right: NO_GIT };
const NO_TARGET: DiffTarget = { key: '' };

const contentNotice = {
  identical: 'Same content on both sides (a rename without changes): nothing to attribute.',
  binary: 'Binary file: git has no lines to attribute.',
  'too-large': 'Too large to diff as text, so no line attribution.',
} as const;

/**
 * What `explain=` names: `/` is the whole comparison, `dir/` a folder, `dir/file` a file. The
 * trailing slash matters, because a file and a folder can have the same name.
 */
function explainValue(node: CompareNode): string {
  return isDirectory(node) ? `${node.path}/` : node.path;
}

function explained(root: CompareNode, value: string | undefined): CompareNode | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === '/') return root;
  return value.endsWith('/') ? findNode(root, value.slice(0, -1)) : findEntry(root, value);
}

/**
 * Both sides as git snapshots pinned to the commits the comparison resolved, so every later
 * analysis (diffs, blame) describes exactly the trees on screen, even after a fetch.
 */
function snapshotPair(
  left: GitSource,
  right: GitSource,
  data: FolderComparison | undefined,
  user: string,
  sessionId: string,
): SnapshotPair | undefined {
  if (!data?.leftSnapshot || !data.rightSnapshot) return undefined;
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
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const path = params.get('path') ?? '';
  const explainParam = params.get('explain') ?? undefined;
  const commitParam = params.get('commit');
  const commitSha = commitParam === null || commitParam === '' ? undefined : commitParam;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<TreeFilter>('all');
  const [startedFolders, setStartedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [searchFolder, setSearchFolder] = useState<string>();
  // Folder statistics are not shown until asked for.
  const [isShowingStats, setShowingStats] = useState(false);

  const query = useQuery(folderCompareQuery(user, sessionId, left, right));
  const data = query.data;
  const pair = useMemo(
    () => snapshotPair(left, right, data, user, sessionId),
    [left, right, data, user, sessionId],
  );
  const current = data ? findNode(data.root, path) : undefined;
  const rows = current && isDirectory(current) ? flattenTree(current, expanded, filter) : [];

  // Only what the user asked to explain is analyzed: a folder, or one file.
  const explainNode = data ? explained(data.root, explainParam) : undefined;
  const scopeDir = explainNode && isDirectory(explainNode) ? explainNode : undefined;
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

  const fileNode = explainNode && !isDirectory(explainNode) ? explainNode : undefined;
  const fileTarget = fileNode ? diffTarget(fileNode) : undefined;
  const isFileDiffable =
    fileNode !== undefined && fileNode.status !== 'identical' && fileNode.status !== 'error';
  const fileQuery = useQuery({
    ...fileDiffQuery(pair ?? NO_PAIR, fileTarget ?? NO_TARGET),
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

  const setSearch = (changes: Record<string, string | undefined>) => {
    void navigate({ search: withParams(params, changes) });
  };

  const goTo = (p: string) => {
    setSearch({ path: p });
  };

  const explain = (node: CompareNode) => {
    setSearch({ explain: node.path === '' ? '/' : explainValue(node), commit: undefined });
  };

  /** Opens one difference in its own File Compare tab, pinned to the commits on screen. */
  const openFileTab = (target: DiffTarget, extra: Record<string, string | undefined> = {}) => {
    if (!pair) return;
    const url = fileUrl(
      user,
      sessionId,
      { left, right, leftCommit: pair.left.branch, rightCommit: pair.right.branch, target },
      extra,
    );
    // Asked for a specific hunk or commit: show exactly that, even in an open tab.
    workspace.open(url, { isExact: Object.values(extra).some((v) => v !== undefined) });
  };

  const open = (node: CompareNode) => {
    if (isDirectory(node)) {
      goTo(node.path);
      return;
    }
    const target = diffTarget(node);
    if (target) openFileTab(target);
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

  const stats = countUnder(current ?? query.data.root);
  const crumbs = breadcrumbs(path);
  const allDifferences = differingFiles(query.data.root);
  const isPanelOpen =
    pair !== undefined &&
    ((explainParam !== undefined && explainParam !== '') || commitSha !== undefined);

  // What the attribution panel explains: the entry the user asked about.
  let scope: AttributionScope = { kind: 'Repository', label: '/' };
  let attribution: ScopeAttribution | undefined;
  let notice: string | undefined;
  let error: string | undefined;
  let progress: AttributionProgress | undefined;
  let onStart: (() => void) | undefined;
  if (fileNode) {
    scope = { kind: 'File', label: fileNode.path };
    const diff = fileQuery.data;
    if (!isFileDiffable) {
      notice =
        fileNode.status === 'identical'
          ? 'Identical in both snapshots: nothing to attribute.'
          : 'This entry could not be read.';
    } else if (fileQuery.isError) error = fileQuery.error.message;
    else if (diff && diff.content !== 'text') notice = contentNotice[diff.content];
    else if (diff && fileTarget) {
      attribution = summarizeAttribution([{ key: fileTarget.key, diff }]);
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
  } else if (explainParam !== undefined && explainParam !== '') {
    notice = `“${explainParam}” is not part of this comparison.`;
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

  // The folder on screen can be explained as a whole, unless that is already shown.
  const canExplainHere =
    pair !== undefined &&
    current !== undefined &&
    isDirectory(current) &&
    current.status !== 'identical' &&
    explainNode !== current;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-surface px-4 py-2 text-sm">
        <Toolbar
          items={[
            {
              key: 'show',
              priority: 'primary',
              node: (
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
              ),
            },
            {
              key: 'statistics',
              priority: 'secondary',
              node: isShowingStats ? (
                <div
                  role="group"
                  aria-label="Summary"
                  className="flex flex-wrap items-center gap-1"
                >
                  {chips.map((chip) =>
                    chip.key === 'errors' && stats.errors === 0 ? null : (
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
                        {chip.label}{' '}
                        <span className="font-semibold tabular-nums">{stats[chip.key]}</span>
                      </button>
                    ),
                  )}
                  <button
                    type="button"
                    className="rounded px-2 py-0.5 text-xs text-muted hover:bg-hover"
                    onClick={() => {
                      setShowingStats(false);
                    }}
                  >
                    Hide statistics
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  aria-expanded={false}
                  className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover"
                  onClick={() => {
                    setShowingStats(true);
                  }}
                >
                  Show current directory statistics
                </button>
              ),
            },
            {
              key: 'actions',
              priority: 'secondary',
              node: (
                <div className="ml-auto flex items-center gap-1">
                  {current && (
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
              ),
            },
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-1.5 text-sm short:py-1">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1">
            {crumbs.map((crumb, i) => {
              const isLast = i === crumbs.length - 1;
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
                      to={{ search: withParams(params, { path: crumb.path }) }}
                      className="text-accent hover:underline"
                    >
                      {label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {canExplainHere && (
            <button
              type="button"
              title="Find the commits that account for the differences in this folder"
              className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
              onClick={() => {
                explain(current);
              }}
            >
              <GitCommitHorizontal className="size-3.5" aria-hidden /> Explain differences here
            </button>
          )}
          <Legend />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            data-testid="column-labels"
            className="grid grid-cols-2 border-b border-line bg-surface text-xs font-medium text-muted"
          >
            {(['left', 'right'] as const).map((side) => {
              const label = side === 'left' ? query.data.leftLabel : query.data.rightLabel;
              const snapshot = side === 'left' ? query.data.leftSnapshot : query.data.rightSnapshot;
              return (
                <div
                  key={side}
                  className={clsx(
                    'flex min-w-0 gap-1 px-3 py-1 font-mono',
                    side === 'right' && 'border-l border-line',
                  )}
                  title={snapshot ? `${label} = ${snapshot.commit}` : label}
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
                onToggle={toggle}
                onOpen={open}
                {...(pair ? { onExplain: explain } : {})}
                highlighted={highlighted}
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

        {isPanelOpen && (
          <Sheet
            title="Explanation"
            onClose={() => {
              setSearch({ explain: undefined, commit: undefined });
            }}
          >
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
              onOpenFile={(key, hunk) => {
                const target = allDifferences.find((t) => t.key === key);
                if (target) {
                  openFileTab(target, {
                    explain: '1',
                    hunk: hunk === undefined ? undefined : String(hunk),
                    commit: commitSha,
                  });
                }
              }}
              commitActions={commitActions}
              onClose={() => {
                setSearch({ explain: undefined, commit: undefined });
              }}
            />
          </Sheet>
        )}
      </div>
    </div>
  );
}

function Legend() {
  const items = [
    ['bg-side-left-dot', 'Only in left'],
    ['bg-side-right-dot', 'Only in right'],
    ['bg-modified-dot', 'Different'],
  ] as const;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" aria-label="Legend">
      {items.map(([dot, label]) => (
        <li key={label} className="flex items-center gap-1">
          <span className={clsx('size-2.5 rounded-sm', dot)} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}
