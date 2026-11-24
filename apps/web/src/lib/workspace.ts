/** One open working context in a session: what it is, and where the user last was in it. */
export type WorkspaceTab = {
  /** The context's identity, see {@link tabIdentity}. */
  id: string;
  /** Path and query of the tab, as the user last left it. */
  url: string;
};

/** What a tab shows. */
export type TabKind = 'home' | 'folders' | 'file' | 'upstream' | 'commit' | 'commits' | 'log';

const KINDS: ReadonlyMap<string, TabKind> = new Map([
  ['folders', 'folders'],
  ['file', 'file'],
  ['upstream', 'upstream'],
  ['commit', 'commit'],
  ['commits', 'commits'],
  ['log', 'log'],
]);

function split(url: string): { pathname: string; params: URLSearchParams } {
  const at = url.indexOf('?');
  return at < 0
    ? { pathname: url, params: new URLSearchParams() }
    : { pathname: url.slice(0, at), params: new URLSearchParams(url.slice(at + 1)) };
}

/** The kind of workspace a URL inside the session `base` shows, if any. */
export function tabKind(url: string, base: string): TabKind | undefined {
  const { pathname } = split(url);
  const rest = pathname.replace(/\/+$/, '');
  if (rest === base) return 'home';
  if (!rest.startsWith(`${base}/`)) return undefined;
  return KINDS.get(rest.slice(base.length + 1));
}

const SOURCES = ['leftRepo', 'leftBranch', 'rightRepo', 'rightBranch'];
const FILE = ['leftRepo', 'rightRepo', 'leftCommit', 'rightCommit', 'leftPath', 'rightPath'];
/** The parameters that make a tab the same context, per kind (the rest is where the user is in it). */
const IDENTITY: Record<Exclude<TabKind, 'home'>, string[]> = {
  folders: SOURCES,
  upstream: SOURCES,
  file: FILE,
  commit: ['repo', 'commit'],
  commits: [...FILE, 'side'],
  log: ['repo', 'top', 'bottom'],
};

function key(params: URLSearchParams, names: string[]): string | undefined {
  const values = names.map((n) => params.get(n) ?? '');
  return values.every((v) => v === '') ? undefined : JSON.stringify(values);
}

/**
 * What makes two URLs the same working context, so an equivalent tab is reused rather than
 * opened twice: a Folder Compare is its two sources (not the folder or filter inside it); a
 * File Compare is the pinned commits and paths (two tabs for one file name can be different
 * snapshot pairs); Upstream is its two sources.
 */
export function tabIdentity(url: string, base: string): string | undefined {
  const kind = tabKind(url, base);
  if (kind === undefined) return undefined;
  if (kind === 'home') return 'home';
  const { params } = split(url);
  return `${kind}:${key(params, IDENTITY[kind]) ?? 'new'}`;
}

/** A tab to drop: closed, or replaced by the active one (which then takes its place). */
export type TabRemoval = { id: string; isTakingPlace: boolean };

/**
 * The open tabs once the user is at `active`: the overview first, then the other contexts in
 * the order they were opened. The active tab is added if new, or updated to where the user is.
 */
export function syncTabs(
  tabs: readonly WorkspaceTab[],
  active: WorkspaceTab,
  homeUrl: string,
  removal?: TabRemoval,
): WorkspaceTab[] {
  const home = tabs.find((t) => t.id === 'home') ?? { id: 'home', url: homeUrl };
  let rest = tabs.filter((t) => t.id !== 'home');
  const isOpen = active.id === 'home' || rest.some((t) => t.id === active.id);
  if (removal && removal.id !== active.id) {
    const at = rest.findIndex((t) => t.id === removal.id);
    if (at >= 0) {
      rest = rest.filter((t) => t.id !== removal.id);
      if (!isOpen && removal.isTakingPlace) rest.splice(at, 0, active);
    }
  }
  if (active.id === 'home') return [{ ...home, url: active.url }, ...rest];
  const next = rest.some((t) => t.id === active.id)
    ? rest.map((t) => (t.id === active.id ? active : t))
    : [...rest, active];
  return [home, ...next];
}

/** A stored tab as written by {@link saveTabs}; anything else is ignored. */
function isTab(value: unknown): value is WorkspaceTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'url' in value &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.url === 'string' &&
    value.url !== ''
  );
}

const storageKey = (user: string, sessionId: string) => `om-tabs:${user}:${sessionId}`;

/** The tabs this browser tab had open in a session (survives reloads; empty if none). */
export function loadTabs(user: string, sessionId: string): WorkspaceTab[] {
  try {
    const raw = sessionStorage.getItem(storageKey(user, sessionId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isTab) ? parsed : [];
  } catch {
    return [];
  }
}

/** Remembers the open tabs for {@link loadTabs}. */
export function saveTabs(user: string, sessionId: string, tabs: readonly WorkspaceTab[]): void {
  try {
    sessionStorage.setItem(storageKey(user, sessionId), JSON.stringify(tabs));
  } catch {
    // Storage full or unavailable: tabs simply won't survive a reload.
  }
}
