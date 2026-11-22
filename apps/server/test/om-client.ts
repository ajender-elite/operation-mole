import type {
  ApplicabilityRequest,
  ApplicabilityResult,
  CommitPatch,
  DirectoryCompareResult,
  GitSource,
  RepoInfo,
  SnapshotFileDiff,
  SnapshotFileDiffRequest,
  UpstreamCommitList,
  UpstreamCommitsRequest,
} from '@om/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

type Distribute<T> = T extends unknown ? Omit<T, 'user' | 'sessionId'> : never;

/** Calls OM's HTTP API in tests (through `app.inject`) for one user's session. */
export class OmClient {
  readonly app: FastifyInstance;
  readonly user: string;
  sessionId = '';

  constructor(app: FastifyInstance, user: string) {
    this.app = app;
    this.user = user;
  }

  async #post<T>(url: string, payload: unknown, status = 200): Promise<T> {
    const res = await this.app.inject({ method: 'POST', url, payload: payload as object });
    expect(res.statusCode, res.body).toBe(status);
    return res.json<T>();
  }

  /** Creates a session and remembers its id. */
  async start(name = 'analysis'): Promise<this> {
    const session = await this.#post<{ id: string }>(
      `/api/users/${this.user}/sessions`,
      { name },
      201,
    );
    this.sessionId = session.id;
    return this;
  }

  async addRepo(url: string): Promise<RepoInfo> {
    const res = await this.app.inject({
      method: 'POST',
      url: `/api/users/${this.user}/sessions/${this.sessionId}/repos`,
      payload: { url },
    });
    expect([200, 201], res.body).toContain(res.statusCode);
    return res.json<RepoInfo>();
  }

  source(repo: RepoInfo, ref: string): GitSource {
    return { type: 'git', repoId: repo.id, branch: ref };
  }

  compare(left: GitSource, right: GitSource): Promise<DirectoryCompareResult> {
    return this.#post('/api/compare/directories', {
      left,
      right,
      user: this.user,
      sessionId: this.sessionId,
    });
  }

  fileDiff(body: Distribute<SnapshotFileDiffRequest>): Promise<SnapshotFileDiff> {
    return this.#post('/api/snapshot/file-diff', {
      ...body,
      user: this.user,
      sessionId: this.sessionId,
    });
  }

  commits(body: Distribute<UpstreamCommitsRequest>): Promise<UpstreamCommitList> {
    return this.#post('/api/upstream/commits', {
      ...body,
      user: this.user,
      sessionId: this.sessionId,
    });
  }

  applicability(body: Distribute<ApplicabilityRequest>): Promise<ApplicabilityResult> {
    return this.#post('/api/upstream/applicability', {
      ...body,
      user: this.user,
      sessionId: this.sessionId,
    });
  }

  patch(upstream: GitSource, commit: string): Promise<CommitPatch> {
    return this.#post('/api/upstream/patch', {
      upstream,
      commit,
      user: this.user,
      sessionId: this.sessionId,
    });
  }

  /** Raw response, for error cases. */
  inject(url: string, payload: object): Promise<LightMyRequestResponse> {
    return this.app.inject({
      method: 'POST',
      url,
      payload: { ...payload, user: this.user, sessionId: this.sessionId },
    });
  }
}
