import type {
  ApplicabilityRequest,
  ApplicabilityResult,
  CommitPatch,
  CommitPatchRequest,
  DefaultsResponse,
  DirectoryCompareRequest,
  DirectoryCompareResult,
  FileCompareResult,
  RepoInfo,
  SessionDetail,
  SessionSummary,
  SnapshotFileDiff,
  SnapshotFileDiffRequest,
  UpstreamCommitList,
  UpstreamCommitsRequest,
} from '@om/shared';
import {
  ApplicabilityResultSchema,
  CommitPatchSchema,
  DefaultsResponseSchema,
  DirectoryCompareResultSchema,
  FileCompareResultSchema,
  RepoInfoSchema,
  SessionDetailSchema,
  SessionSummaryListSchema,
  SessionSummarySchema,
  SnapshotFileDiffSchema,
  UpstreamCommitListSchema,
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
 * Compares two sources (`POST /api/compare/directories`); recorded in the session's recents when `user` and `sessionId` are set.
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function compareDirectories(body: DirectoryCompareRequest): Promise<DirectoryCompareResult> {
  return request(
    '/api/compare/directories',
    (b) => DirectoryCompareResultSchema.parse(b),
    json('POST', body),
  );
}

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
 * Contents and equality of two files for the diff view (`GET /api/compare/files`); empty sides are left out.
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function compareFiles(
  left: string | undefined,
  right: string | undefined,
): Promise<FileCompareResult> {
  const params = new URLSearchParams();
  if (left !== undefined && left !== '') params.set('left', left);
  if (right !== undefined && right !== '') params.set('right', right);
  return request(`/api/compare/files?${params}`, (b) => FileCompareResultSchema.parse(b));
}

/**
 * Folders to compare when the URL names none (`GET /api/defaults`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function getDefaults(): Promise<DefaultsResponse> {
  return request('/api/defaults', (b) => DefaultsResponseSchema.parse(b));
}

/**
 * One file between two git snapshots, with git's hunks and per-line attribution (`POST /api/snapshot/file-diff`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function snapshotFileDiff(
  body: SnapshotFileDiffRequest,
  signal?: AbortSignal,
): Promise<SnapshotFileDiff> {
  return request('/api/snapshot/file-diff', (b) => SnapshotFileDiffSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * A window of upstream commits and whether downstream contains each (`POST /api/upstream/commits`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function upstreamCommits(
  body: UpstreamCommitsRequest,
  signal?: AbortSignal,
): Promise<UpstreamCommitList> {
  return request('/api/upstream/commits', (b) => UpstreamCommitListSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * What applying one upstream commit to the pristine downstream snapshot does (`POST /api/upstream/applicability`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function applicability(
  body: ApplicabilityRequest,
  signal?: AbortSignal,
): Promise<ApplicabilityResult> {
  return request('/api/upstream/applicability', (b) => ApplicabilityResultSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * A commit's files and hunks against its first parent (`POST /api/upstream/patch`).
 * @throws {ApiRequestError} When the API is unreachable, answers with an error, or returns an unexpected shape.
 */
export function commitPatch(body: CommitPatchRequest, signal?: AbortSignal): Promise<CommitPatch> {
  return request('/api/upstream/patch', (b) => CommitPatchSchema.parse(b), {
    ...json('POST', body),
    ...(signal ? { signal } : {}),
  });
}
