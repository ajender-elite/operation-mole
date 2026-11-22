/** The pages inside a session, as URL segments. */
export type SessionPage = 'folders' | 'files' | 'upstream';

/** URL of a session, or of one of its pages. */
export function sessionPath(user: string, sessionId: string, page?: SessionPage): string {
  const base = `/u/${encodeURIComponent(user)}/s/${encodeURIComponent(sessionId)}`;
  return page ? `${base}/${page}` : base;
}
