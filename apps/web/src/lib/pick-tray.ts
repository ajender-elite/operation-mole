/**
 * The commits collected for a series in one repo of one session: what the user added from the History and
 * commit views, kept in this browser tab so the Series tab opens with them. The URL (`picks=`) stays the
 * source of truth once the Series tab is open; the tray only remembers the list between tabs.
 */

const FULL_SHA = /^[0-9a-f]{40}$/;

const storageKey = (user: string, sessionId: string, repoId: string) =>
  `om-picks:${user}:${sessionId}:${repoId}`;

/** The picks in order (oldest first, as they will be applied). Anything that is not a full SHA is dropped. */
export function loadPicks(user: string, sessionId: string, repoId: string): string[] {
  try {
    const raw = sessionStorage.getItem(storageKey(user, sessionId, repoId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && FULL_SHA.test(p));
  } catch {
    return [];
  }
}

/** Remembers the picks for {@link loadPicks}. */
export function savePicks(
  user: string,
  sessionId: string,
  repoId: string,
  picks: readonly string[],
): void {
  try {
    sessionStorage.setItem(storageKey(user, sessionId, repoId), JSON.stringify(picks));
  } catch {
    // Storage full or unavailable: the picks are still in the URL once the Series tab is open.
  }
}

/** The picks with `sha` at the end, unless it is already there (the list is returned unchanged then). */
export function withPick(picks: readonly string[], sha: string): string[] {
  return picks.includes(sha) ? [...picks] : [...picks, sha];
}
