import type { RepoInfo } from '@om/shared';
import clsx from 'clsx';
import {
  ChevronDown,
  FileCode,
  FileDiff,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitPullRequestArrow,
  LayoutDashboard,
  ListChecks,
  ListTree,
  Search,
  X,
} from 'lucide-react';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { shortSha } from '../lib/attribution.ts';
import { isEditable } from '../lib/keys.ts';
import { MEDIA, useMediaQuery } from '../lib/media.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { sourceFromParams, sourceLabel } from '../lib/sources.ts';
import { sessionPath } from '../lib/urls.ts';
import { WorkspaceContext, type Workspace } from '../lib/workspace-context.ts';
import { HeaderSlotContext } from './header-slot.tsx';
import { ShortcutsDialog } from './shortcuts-dialog.tsx';
import {
  loadTabs,
  saveTabs,
  syncTabs,
  tabIdentity,
  tabKind,
  type TabKind,
  type TabRemoval,
  type WorkspaceTab,
} from '../lib/workspace.ts';
import { BetweenPage } from '../pages/between-page.tsx';
import { BranchesPage } from '../pages/branches-page.tsx';
import { CodePage } from '../pages/code-page.tsx';
import { SearchPage } from '../pages/search-page.tsx';
import { SeriesPage } from '../pages/series-page.tsx';
import { CommitsPage, LegacyHistoryRedirect } from '../pages/commits-page.tsx';
import { CommitPage } from '../pages/commit-page.tsx';
import { DirectoryComparePage } from '../pages/directory-compare-page.tsx';
import { FileComparePage } from '../pages/file-compare-page.tsx';
import { NotFoundPage } from '../pages/not-found-page.tsx';
import { SessionOverviewPage } from '../pages/session-overview-page.tsx';
import { UpstreamRedirect } from '../pages/upstream-redirect.tsx';

/** The active location is not a workspace (an unknown page inside the session). */
const OTHER = 'other';

/** What a navigation asks the workspace to drop, carried in the history entry's state. */
function removalFrom(state: unknown): TabRemoval | undefined {
  if (typeof state !== 'object' || state === null || !('removeTab' in state)) return undefined;
  const { removeTab } = state;
  if (typeof removeTab !== 'string') return undefined;
  const isTakingPlace = 'isTakingPlace' in state && state.isTakingPlace === true;
  return { id: removeTab, isTakingPlace };
}

/**
 * Everything inside a session: the Overview, and each Folder Compare, File Compare and Upstream
 * analysis the user opened, each in its own tab. Tabs stay mounted once visited, so going back
 * to one finds it exactly as it was left (folder, expanded rows, filters, scroll position).
 */
export function SessionWorkspace(): JSX.Element {
  const { user, sessionId } = useSessionParams();
  return <SessionTabs key={`${user}/${sessionId}`} user={user} sessionId={sessionId} />;
}

function SessionTabs({ user, sessionId }: { user: string; sessionId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const base = sessionPath(user, sessionId);
  const url = `${location.pathname}${location.search}`;
  const activeId = tabIdentity(url, base) ?? OTHER;
  const removal = useMemo(() => removalFrom(location.state), [location.state]);

  const [stored, setStored] = useState(() => loadTabs(user, sessionId));
  const tabs = useMemo(() => {
    if (activeId !== OTHER) return syncTabs(stored, { id: activeId, url }, base, removal);
    // An unknown page is not a tab: keep the open ones as they are.
    const home = stored.find((t) => t.id === 'home') ?? { id: 'home', url: base };
    return syncTabs(stored, home, base);
  }, [stored, activeId, url, base, removal]);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([activeId]));
  if (!visited.has(activeId)) setVisited(new Set(visited).add(activeId));

  // Remember where the user now is. Only when something changed, so this settles at once.
  if (JSON.stringify(tabs) !== JSON.stringify(stored)) setStored(tabs);
  useEffect(() => {
    saveTabs(user, sessionId, tabs);
  }, [tabs, user, sessionId]);

  // ? lists the keyboard shortcuts. Ignored while the user types in a field, where ? is a letter.
  const [isHelpOpen, setHelpOpen] = useState(false);
  const closeHelp = useCallback(() => {
    setHelpOpen(false);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      if (event.key === '?') {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const workspace = useMemo<Workspace>(
    () => ({
      open: (target, options = {}) => {
        const id = tabIdentity(target, base);
        const existing = tabs.find((t) => t.id === id);
        const to =
          existing && options.isExact !== true && existing.id !== activeId ? existing.url : target;
        const state =
          options.isReplacing === true ? { removeTab: activeId, isTakingPlace: true } : null;
        void navigate(to, { state });
      },
    }),
    [tabs, base, activeId, navigate],
  );

  const close = (id: string) => {
    if (id !== activeId) {
      setStored(tabs.filter((t) => t.id !== id));
      return;
    }
    const at = tabs.findIndex((t) => t.id === id);
    const next = tabs[at - 1] ?? tabs[at + 1] ?? tabs[0];
    void navigate(next?.url ?? base, { state: { removeTab: id, isTakingPlace: false } });
  };

  // In landscape on a phone the tab strip moves into the app header, so header and tabs share a row.
  const headerSlot = useContext(HeaderSlotContext);
  const isShort = useMediaQuery(MEDIA.short);
  const strip =
    tabs.length > 1 ? (
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        base={base}
        user={user}
        sessionId={sessionId}
        onSelect={(tab) => {
          void navigate(tab.url);
        }}
        onClose={close}
      />
    ) : null;
  return (
    <WorkspaceContext.Provider value={workspace}>
      {isHelpOpen && <ShortcutsDialog onClose={closeHelp} />}
      {strip !== null && isShort && headerSlot !== null ? createPortal(strip, headerSlot) : strip}
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          if (!isActive && !visited.has(tab.id)) return null;
          return (
            <TabPanel key={tab.id} id={tab.id} isActive={isActive}>
              <Routes location={isActive ? location : tab.url}>
                <Route index element={<SessionOverviewPage />} />
                <Route path="folders" element={<DirectoryComparePage />} />
                <Route path="file" element={<FileComparePage />} />
                {/* Upstream is now Between; old links open Between with the same branches. */}
                <Route path="upstream" element={<UpstreamRedirect />} />
                <Route path="commit" element={<CommitPage />} />
                {/* One Commits tab: the old Range Log (log) and Commit List (commits?side=) URLs open it too. */}
                <Route path="commits" element={<CommitsPage />} />
                <Route path="log" element={<CommitsPage />} />
                <Route path="code" element={<CodePage />} />
                <Route path="history" element={<LegacyHistoryRedirect />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="branches" element={<BranchesPage />} />
                <Route path="series" element={<SeriesPage />} />
                <Route path="between" element={<BetweenPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </TabPanel>
          );
        })}
        {activeId === OTHER && (
          <TabPanel id={OTHER} isActive>
            <NotFoundPage />
          </TabPanel>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}

function TabPanel({
  id,
  isActive,
  children,
}: {
  id: string;
  isActive: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`tab-${id}`}
      aria-hidden={!isActive}
      inert={!isActive}
      // Hidden, not removed or `display: none`: the tab keeps its state and scroll position.
      style={isActive ? undefined : { visibility: 'hidden' }}
      className="absolute inset-0 flex flex-col"
    >
      {children}
    </div>
  );
}

const kindIcon: Record<TabKind, typeof FolderTree> = {
  home: LayoutDashboard,
  folders: FolderTree,
  file: FileDiff,
  upstream: GitPullRequestArrow,
  commit: GitCommitHorizontal,
  commits: ListTree,
  code: FileCode,
  search: Search,
  branches: GitBranch,
  series: ListChecks,
  between: GitCompare,
};

/** A tab's name, from its URL and the session's repos (so it follows renames and fetches). */
function tabTitle(tab: WorkspaceTab, base: string, repos: RepoInfo[]): string {
  const kind = tabKind(tab.url, base);
  const at = tab.url.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : tab.url.slice(at + 1));
  const left = sourceFromParams(params, 'left');
  const right = sourceFromParams(params, 'right');
  switch (kind) {
    case 'folders':
      return left && right
        ? `${sourceLabel(left, repos)} ↔ ${sourceLabel(right, repos)}`
        : 'New comparison';
    case 'file': {
      const path = params.get('rightPath') ?? params.get('leftPath') ?? '';
      return path.split('/').at(-1) ?? path;
    }
    case 'upstream':
      return left && right
        ? `Upstream ${sourceLabel(left, repos)} → ${sourceLabel(right, repos)}`
        : 'Upstream';
    case 'commit':
      return `Commit ${shortSha(params.get('commit') ?? '')}`;
    case 'commits': {
      const folder = params.get('path') ?? '';
      const ref = params.get('ref') ?? '';
      const range = params.get('notIn');
      if (folder !== '') return `Commits ${folder.split('/').at(-1) ?? folder}`;
      return range === null || range === '' ? `Commits ${ref}` : `${ref} not in ${range}`;
    }
    case 'code': {
      const repo = repos.find((r) => r.id === params.get('repo'));
      const where = repo?.name ?? 'repo';
      const folder = params.get('path') ?? '';
      const last = folder.split('/').at(-1) ?? '';
      return `${last === '' ? where : last} @ ${params.get('ref') ?? ''}`;
    }
    case 'search':
      return (params.get('q') ?? '') === '' ? 'Search' : `Search ${params.get('q') ?? ''}`;
    case 'branches':
      return `Branches ${repos.find((r) => r.id === params.get('repo'))?.name ?? ''}`.trim();
    case 'between': {
      const leftName = params.get('left') ?? '';
      const rightName = params.get('right') ?? '';
      return leftName === '' || rightName === '' ? 'Between' : `${leftName} … ${rightName}`;
    }
    case 'series':
      return 'Series';
    case 'home':
    case undefined:
      return 'Overview';
  }
}

/** Whether a horizontal list still has tabs beyond its right edge. */
function hasMoreAfter(list: HTMLElement): boolean {
  return list.scrollWidth - list.scrollLeft - list.clientWidth > 1;
}

function TabStrip({
  tabs,
  activeId,
  base,
  user,
  sessionId,
  onSelect,
  onClose,
}: {
  tabs: WorkspaceTab[];
  activeId: string;
  base: string;
  user: string;
  sessionId: string;
  onSelect: (tab: WorkspaceTab) => void;
  onClose: (id: string) => void;
}) {
  const session = useSessionDetail(user, sessionId);
  const repos = session.data?.repos ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  const [isMoreAfter, setMoreAfter] = useState(false);
  const [isMenuOpen, setMenuOpen] = useState(false);

  // A fade on the right says there are more tabs to scroll to. Re-measured on resize and tab changes.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      setMoreAfter(hasMoreAfter(list));
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
    };
  }, [tabs.length]);

  const entries = tabs.map((tab) => {
    const title = tabTitle(tab, base, repos);
    const path = new URLSearchParams(tab.url.split('?')[1] ?? '');
    const fullPath = path.get('rightPath') ?? path.get('leftPath');
    return {
      tab,
      title,
      fullPath,
      Icon: kindIcon[tabKind(tab.url, base) ?? 'home'],
      isActive: tab.id === activeId,
    };
  });

  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-line bg-canvas px-2 pt-1 short:min-w-0 short:flex-1 short:border-b-0 short:bg-transparent short:px-0 short:pt-0">
      <div className="relative flex min-w-0 flex-1">
        <div
          role="tablist"
          aria-label="Open comparisons"
          ref={listRef}
          className="flex min-w-0 flex-1 gap-px overflow-x-auto"
          onScroll={(event) => {
            setMoreAfter(hasMoreAfter(event.currentTarget));
          }}
        >
          {entries.map(({ tab, title, fullPath, Icon, isActive }) => (
            <div
              key={tab.id}
              className={clsx(
                'group flex max-w-40 shrink-0 items-center rounded-t-md border border-b-0 text-sm sm:max-w-64',
                isActive
                  ? 'border-line bg-surface font-medium text-ink'
                  : 'border-transparent text-muted hover:bg-hover',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`tab-${tab.id}`}
                title={fullPath ?? title}
                className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1.5"
                onClick={() => {
                  onSelect(tab);
                }}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{title}</span>
              </button>
              {tab.id !== 'home' && (
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  title="Close"
                  className={clsx(
                    'touch-target mr-1 rounded p-0.5 hover:bg-hover hover:text-ink',
                    // A phone has no hover: inactive tabs keep their close button visible.
                    !isActive &&
                      'invisible group-focus-within:visible group-hover:visible coarse:visible',
                  )}
                  onClick={() => {
                    onClose(tab.id);
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
        {isMoreAfter && (
          <div
            data-fade="end"
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-canvas to-transparent"
          />
        )}
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={isMenuOpen}
          className="touch-target flex items-center gap-1 rounded-t-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink"
          onClick={() => {
            setMenuOpen((open) => !open);
          }}
        >
          Tabs <ChevronDown className="size-3.5" aria-hidden />
        </button>
        {isMenuOpen && (
          <div
            role="group"
            aria-label="Open tabs"
            className="absolute right-0 z-30 mt-1 flex max-h-[70vh] min-w-56 flex-col overflow-auto rounded-md border border-line bg-surface p-1 shadow-lg"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setMenuOpen(false);
            }}
          >
            {entries.map(({ tab, title, fullPath, Icon, isActive }) => (
              <div
                key={tab.id}
                className={clsx('flex items-center gap-1 rounded', isActive && 'bg-accent-soft')}
              >
                <button
                  type="button"
                  aria-label={`Switch to ${title}`}
                  title={fullPath ?? title}
                  className="touch-target flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-hover"
                  onClick={() => {
                    setMenuOpen(false);
                    onSelect(tab);
                  }}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{title}</span>
                </button>
                {tab.id !== 'home' && (
                  <button
                    type="button"
                    aria-label={`Close ${title}`}
                    title="Close"
                    className="touch-target rounded p-1 text-muted hover:bg-hover hover:text-ink"
                    onClick={() => {
                      onClose(tab.id);
                    }}
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
