import type { RepoInfo } from '@om/shared';
import clsx from 'clsx';
import {
  FileDiff,
  FolderTree,
  GitCommitHorizontal,
  GitPullRequestArrow,
  LayoutDashboard,
  ListTree,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { shortSha } from '../lib/attribution.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { sourceFromParams, sourceLabel } from '../lib/sources.ts';
import { sessionPath } from '../lib/urls.ts';
import { WorkspaceContext, type Workspace } from '../lib/workspace-context.ts';
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
import { CommitListPage } from '../pages/commits-page.tsx';
import { CommitPage } from '../pages/commit-page.tsx';
import { DirectoryComparePage } from '../pages/directory-compare-page.tsx';
import { FileComparePage } from '../pages/file-compare-page.tsx';
import { NotFoundPage } from '../pages/not-found-page.tsx';
import { SessionOverviewPage } from '../pages/session-overview-page.tsx';
import { UpstreamPage } from '../pages/upstream-page.tsx';

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

  return (
    <WorkspaceContext.Provider value={workspace}>
      {tabs.length > 1 && (
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
      )}
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
                <Route path="upstream" element={<UpstreamPage />} />
                <Route path="commit" element={<CommitPage />} />
                <Route path="commits" element={<CommitListPage />} />
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
    case 'commits':
      return params.get('side') === 'right' ? 'Target commits' : 'Base commits';
    case 'home':
    case undefined:
      return 'Overview';
  }
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
  return (
    <div
      role="tablist"
      aria-label="Open comparisons"
      className="flex shrink-0 gap-px overflow-x-auto border-b border-line bg-canvas px-2 pt-1"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const title = tabTitle(tab, base, repos);
        const Icon = kindIcon[tabKind(tab.url, base) ?? 'home'];
        const path = new URLSearchParams(tab.url.split('?')[1] ?? '');
        const fullPath = path.get('rightPath') ?? path.get('leftPath');
        return (
          <div
            key={tab.id}
            className={clsx(
              'group flex max-w-64 shrink-0 items-center rounded-t-md border border-b-0 text-sm',
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
                  'mr-1 rounded p-0.5 hover:bg-hover hover:text-ink',
                  !isActive && 'invisible group-focus-within:visible group-hover:visible',
                )}
                onClick={() => {
                  onClose(tab.id);
                }}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
