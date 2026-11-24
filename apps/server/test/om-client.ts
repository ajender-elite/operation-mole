import type {
  FolderComparison,
  GitCompareTrees,
  GitSource,
  RepoInfo,
  SnapshotFileDiff,
} from '@om/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

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

  /**
   * Uses this user's session of that name, creating it on first use. For data that a test run keeps
   * between runs (a clone made once per machine).
   */
  async startOrResume(name: string): Promise<this> {
    const res = await this.app.inject({ method: 'GET', url: `/api/users/${this.user}/sessions` });
    expect(res.statusCode, res.body).toBe(200);
    const existing = res.json<Array<{ id: string; name: string }>>().find((s) => s.name === name);
    if (existing === undefined) return await this.start(name);
    this.sessionId = existing.id;
    return this;
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

  /** Adds another remote to a repo (and fetches it), as the Repos page does. */
  async addRemote(repo: RepoInfo, name: string, url: string): Promise<void> {
    await this.#post<unknown>(
      `/api/users/${this.user}/sessions/${this.sessionId}/repos/${repo.id}/remotes`,
      { name, url },
      201,
    );
  }

  source(repo: RepoInfo, ref: string): GitSource {
    return { type: 'git', repoId: repo.id, branch: ref };
  }

  /** Folder Compare of two git sides: the folder tree (from `compare-trees`). */
  async compare(left: GitSource, right: GitSource): Promise<FolderComparison> {
    const trees = await this.#post<GitCompareTrees>('/api/git/compare-trees', {
      left,
      right,
      user: this.user,
      sessionId: this.sessionId,
    });
    return trees.folder;
  }

  /** One file's hunks between two git sides, from `POST /api/git/diff` (the file pair's only entry). */
  async fileDiff(body: {
    left: GitSource;
    right: GitSource;
    leftPath?: string;
    rightPath?: string;
    fullFile?: boolean;
  }): Promise<SnapshotFileDiff> {
    const res = await this.#post<{ files: SnapshotFileDiff[] }>('/api/git/diff', {
      left: body.left,
      right: body.right,
      files: [{ leftPath: body.leftPath, rightPath: body.rightPath }],
      fullFile: body.fullFile ?? false,
      user: this.user,
      sessionId: this.sessionId,
    });
    const [file] = res.files;
    if (file === undefined) throw new Error('the diff has no file');
    return file;
  }

  inject(url: string, payload: object): Promise<LightMyRequestResponse> {
    return this.app.inject({
      method: 'POST',
      url,
      payload: { ...payload, user: this.user, sessionId: this.sessionId },
    });
  }
}
