import type {
  AddRemoteRequest,
  GitCherryPick,
  GitContains,
  GitContainsRequest,
  GitCherryPickRequest,
  GitFiles,
  GitFilesRequest,
  GitFile,
  GitFileRequest,
  GitGrep,
  GitGrepRequest,
  GitRefs,
  GitRefsRequest,
  GitTree,
  GitTreeRequest,
  CommitPatch,
  GitAncestry,
  GitAncestryRequest,
  GitCompareTrees,
  GitCompareTreesRequest,
  GitBlame,
  GitBlameRequest,
  GitDiff,
  GitDiffRequest,
  GitLog,
  GitLogRequest,
  GitMergeTree,
  GitMergeTreeRequest,
  GitPatchEquivalents,
  GitPatchEquivalentsRequest,
  GitResolve,
  GitResolveRequest,
  GitShowRequest,
  RemoteCheck,
  RepoInfo,
  ServerInfo,
  SessionDetail,
  SessionSummary,
} from '@om/shared';
import {
  CommitPatchSchema,
  GitCherryPickSchema,
  GitContainsSchema,
  GitFileSchema,
  GitFilesSchema,
  GitGrepSchema,
  GitRefsSchema,
  GitTreeSchema,
  RemoteCheckSchema,
  GitAncestrySchema,
  GitCompareTreesSchema,
  GitBlameSchema,
  GitResolveSchema,
  GitDiffSchema,
  GitLogSchema,
  GitMergeTreeSchema,
  GitPatchEquivalentsSchema,
  RepoInfoSchema,
  ServerInfoSchema,
  SessionDetailSchema,
  SessionSummaryListSchema,
  SessionSummarySchema,
} from '@om/shared';

/** A failed API call. `status` is the HTTP status, or 0 when the server could not be reached. */
export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  readonly status: number;
  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

const UNREACHABLE =
  "Can't reach the OM API server. Make sure it is running (pnpm dev), then try again.";

/** Checks a successful response body; throws when it has the wrong shape. */
type ParseBody<T> = (body: unknown) => T;

/** Sends a request and returns its JSON body (undefined when empty); throws on API errors. */
async function send(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(new URL(path, window.location.origin), init);
  } catch (error) {
    // A cancelled request (navigated away, query cancelled) is not an unreachable server.
    if (init?.signal?.aborted === true) throw error;
    throw new ApiRequestError(UNREACHABLE, 0);
  }
  // The Vite dev proxy answers 502/503/504 when the API process is down.
  if ([502, 503, 504].includes(res.status)) throw new ApiRequestError(UNREACHABLE, res.status);
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : `Request failed (${res.status})`;
    throw new ApiRequestError(message, res.status);
  }
  return { status: res.status, body };
}

/** Sends a request and validates the response body with `parse` (a shared zod schema's). */
async function request<T>(path: string, parse: ParseBody<T>, init?: RequestInit): Promise<T> {
  const { status, body } = await send(path, init);
  try {
    return parse(body);
  } catch (error) {
    throw new ApiRequestError(`Unexpected response from the OM API (${path})`, status, {
      cause: error,
    });
  }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});

const sessionsUrl = (user: string) => `/api/users/${encodeURIComponent(user)}/sessions`;
const sessionUrl = (user: string, sessionId: string) =>
  `${sessionsUrl(user)}/${encodeURIComponent(sessionId)}`;

/**
 * The user's sessions, most recently used first (`GET /api/users/:user/sessions`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function listSessions(user: string): Promise<SessionSummary[]> {
  return request(sessionsUrl(user), (b) => SessionSummaryListSchema.parse(b));
}

/**
 * Creates a session named `name` for `user` (`POST /api/users/:user/sessions`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape. A duplicate name is a 409.
 */
export function createSession(user: string, name: string): Promise<SessionSummary> {
  return request(sessionsUrl(user), (b) => SessionSummarySchema.parse(b), json('POST', { name }));
}

/**
 * A session with its repos and recent comparisons (`GET /api/users/:user/sessions/:sessionId`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function getSession(user: string, sessionId: string): Promise<SessionDetail> {
  return request(sessionUrl(user, sessionId), (b) => SessionDetailSchema.parse(b));
}

/**
 * Deletes a session and its clones (`DELETE /api/users/:user/sessions/:sessionId`).
 * @throws {ApiRequestError} When the API is unreachable or answers with an error (404 if already gone).
 */
export async function deleteSession(user: string, sessionId: string): Promise<void> {
  await send(sessionUrl(user, sessionId), json('DELETE'));
}

/**
 * Clones `url` into the session, or returns the existing clone (`POST …/repos`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function addRepo(user: string, sessionId: string, url: string): Promise<RepoInfo> {
  return request(
    `${sessionUrl(user, sessionId)}/repos`,
    (b) => RepoInfoSchema.parse(b),
    json('POST', { url }),
  );
}

/**
 * Fetches the latest branches for a cloned repo (`POST …/repos/:repoId/fetch`). OM never fetches on its own.
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function fetchRepo(user: string, sessionId: string, repoId: string): Promise<RepoInfo> {
  return request(
    `${sessionUrl(user, sessionId)}/repos/${encodeURIComponent(repoId)}/fetch`,
    (b) => RepoInfoSchema.parse(b),
    json('POST'),
  );
}

/**
 * Adds a remote to a repo under its name, and fetches it (`POST …/repos/:repoId/remotes`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error (409 for a name or URL in use, or the limit), or returns an unexpected shape.
 */
export function addRemote(
  user: string,
  sessionId: string,
  repoId: string,
  remote: AddRemoteRequest,
): Promise<RepoInfo> {
  return request(
    `${sessionUrl(user, sessionId)}/repos/${encodeURIComponent(repoId)}/remotes`,
    (b) => RepoInfoSchema.parse(b),
    json('POST', remote),
  );
}

/**
 * Whether one remote answers now, and git's reason when it does not (`POST …/remotes/:name/check`).
 * @throws {ApiRequestError} When the API is unreachable or answers with an error (404 for an unknown remote).
 */
export function checkRemote(
  user: string,
  sessionId: string,
  repoId: string,
  name: string,
): Promise<RemoteCheck> {
  return request(
    `${sessionUrl(user, sessionId)}/repos/${encodeURIComponent(repoId)}/remotes/${encodeURIComponent(name)}/check`,
    (b) => RemoteCheckSchema.parse(b),
    json('POST'),
  );
}

/**
 * Fetches one remote of a repo, leaving the others as they are (`POST …/remotes/:name/fetch`).
 * @throws {ApiRequestError} When the API is unreachable or answers with an error.
 */
export function fetchRemote(
  user: string,
  sessionId: string,
  repoId: string,
  name: string,
): Promise<RepoInfo> {
  return request(
    `${sessionUrl(user, sessionId)}/repos/${encodeURIComponent(repoId)}/remotes/${encodeURIComponent(name)}/fetch`,
    (b) => RepoInfoSchema.parse(b),
    json('POST'),
  );
}

/**
 * Removes one remote from a repo (`DELETE …/remotes/:name`). A repo keeps at least one remote.
 * @throws {ApiRequestError} When the API is unreachable or answers with an error (409 for the last remote).
 */
export async function removeRemote(
  user: string,
  sessionId: string,
  repoId: string,
  name: string,
): Promise<void> {
  await send(
    `${sessionUrl(user, sessionId)}/repos/${encodeURIComponent(repoId)}/remotes/${encodeURIComponent(name)}`,
    json('DELETE'),
  );
}

/**
 * A page of the commits reachable from `source` and not from `exclude`, newest first (`POST /api/git/log`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitLog(body: GitLogRequest, signal?: AbortSignal): Promise<GitLog> {
  return request('/api/git/log', (b) => GitLogSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * One commit's metadata and changes against its first parent (`POST /api/git/show`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitShow(body: GitShowRequest, signal?: AbortSignal): Promise<CommitPatch> {
  return request('/api/git/show', (b) => CommitPatchSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The hunks of one file pair between two commits, without attribution (`POST /api/git/diff`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitDiff(body: GitDiffRequest, signal?: AbortSignal): Promise<GitDiff> {
  return request('/api/git/diff', (b) => GitDiffSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Who last changed the given lines of a file at a commit (`POST /api/git/blame`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitBlame(body: GitBlameRequest, signal?: AbortSignal): Promise<GitBlame> {
  return request('/api/git/blame', (b) => GitBlameSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Whether each commit is in the history of a tip (`POST /api/git/ancestry`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitAncestry(body: GitAncestryRequest, signal?: AbortSignal): Promise<GitAncestry> {
  return request('/api/git/ancestry', (b) => GitAncestrySchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The file-by-file and folder comparison of two git sides, from their trees (`POST /api/git/compare-trees`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitCompareTrees(
  body: GitCompareTreesRequest,
  signal?: AbortSignal,
): Promise<GitCompareTrees> {
  return request('/api/git/compare-trees', (b) => GitCompareTreesSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The commit each revision names right now (`POST /api/git/resolve`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitResolve(body: GitResolveRequest, signal?: AbortSignal): Promise<GitResolve> {
  return request('/api/git/resolve', (b) => GitResolveSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Merges `theirs` into `ours` in a scratch store: whether it is clean, what it changes and what conflicts
 * (`POST /api/git/merge-tree`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitMergeTree(
  body: GitMergeTreeRequest,
  signal?: AbortSignal,
): Promise<GitMergeTree> {
  return request('/api/git/merge-tree', (b) => GitMergeTreeSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The commits on each side of `left...right` and which make the same change on the other side
 * (`POST /api/git/patch-equivalents`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitPatchEquivalents(
  body: GitPatchEquivalentsRequest,
  signal?: AbortSignal,
): Promise<GitPatchEquivalents> {
  return request('/api/git/patch-equivalents', (b) => GitPatchEquivalentsSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The server's git version, what its git can reach, and the limits on sessions, repos and remotes
 * (`GET /api/server`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function getServerInfo(): Promise<ServerInfo> {
  return request('/api/server', (b) => ServerInfoSchema.parse(b));
}

/**
 * Removes a repo from a session: its clone and worktrees, then its row (`DELETE …/repos/:repoId`).
 * @throws {ApiRequestError} When the API is unreachable or answers with an error (404 if already gone).
 */
export async function deleteRepo(user: string, sessionId: string, repoId: string): Promise<void> {
  await send(`${sessionUrl(user, sessionId)}/repos/${encodeURIComponent(repoId)}`, json('DELETE'));
}

/**
 * One folder of a commit's tree, one level deep: its folders and files, folders first (`POST /api/git/tree`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error (404 when the folder is missing), or returns an unexpected shape.
 */
export function gitTree(body: GitTreeRequest, signal?: AbortSignal): Promise<GitTree> {
  return request('/api/git/tree', (b) => GitTreeSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * One file of a commit, whole: its text, or why there is none (`POST /api/git/file`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error (404 for a missing file), or returns an unexpected shape.
 */
export function gitFile(body: GitFileRequest, signal?: AbortSignal): Promise<GitFile> {
  return request('/api/git/file', (b) => GitFileSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Lines of a commit that match a query, with context (`POST /api/git/grep`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitGrep(body: GitGrepRequest, signal?: AbortSignal): Promise<GitGrep> {
  return request('/api/git/grep', (b) => GitGrepSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Every branch and tag of every remote of a repo, with how far each is ahead of and behind `compareTo`
 * (`POST /api/git/refs`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitRefs(body: GitRefsRequest, signal?: AbortSignal): Promise<GitRefs> {
  return request('/api/git/refs', (b) => GitRefsSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Would `git cherry-pick` of these commits, in order, onto a branch succeed? A dry run: nothing is written
 * (`POST /api/git/cherry-pick`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitCherryPick(
  body: GitCherryPickRequest,
  signal?: AbortSignal,
): Promise<GitCherryPick> {
  return request('/api/git/cherry-pick', (b) => GitCherryPickSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Every file path of a commit, sorted, for go-to-file (`POST /api/git/files`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitFiles(body: GitFilesRequest, signal?: AbortSignal): Promise<GitFiles> {
  return request('/api/git/files', (b) => GitFilesSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The branches and tags, of every remote, that contain a commit (`POST /api/git/contains`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function gitContains(body: GitContainsRequest, signal?: AbortSignal): Promise<GitContains> {
  return request('/api/git/contains', (b) => GitContainsSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}
