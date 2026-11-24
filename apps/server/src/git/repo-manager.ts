import { existsSync, readdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type AddRemoteRequest,
  DEFAULT_REMOTE,
  type GitSource,
  type RepoInfo,
  type ServerLimits,
  UsernameSchema,
} from '@om/shared';
import type { AnalysisCache, CacheScope } from '../cache/analysis-cache.ts';
import { CompareInputError, ConflictError, NotFoundError } from '../errors.ts';
import type { RepoRecord, Store } from '../store/store.ts';
import type { StoreRegistry } from '../store/store-registry.ts';
import { GitService } from './git-service.ts';

/** A git side resolved to an exact commit in one of the session's clones. */
export type ResolvedSnapshot = {
  /** The bare clone holding the commit (its object database and history). */
  repoDir: string;
  /** Full commit SHA. */
  commit: string;
  /** What was asked for (branch, tag or commit). */
  ref: string;
  /** The remote the branch is on. */
  remote: string;
  label: string;
  /** The repo whose cache holds this snapshot's results. */
  cacheScope: CacheScope;
};

/** The API view of a stored repo (drops the owning session id). */
export const toInfo = (r: RepoRecord): RepoInfo => ({
  id: r.id,
  url: r.url,
  name: r.name,
  defaultBranch: r.defaultBranch,
  branches: r.branches,
  fetchedAt: r.fetchedAt,
  remotes: r.remotes,
});

/** Normalizes a repo URL so the same repo typed slightly differently is reused. */
const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * Per-session git workspaces on disk:
 *   <dataDir>/users/<user>/sessions/<session>/repos/<repo>                  bare clone (all its remotes)
 */
export class RepoManager {
  readonly #stores: StoreRegistry;
  readonly #git: GitService;
  readonly #dataDir: string;
  readonly #limits: ServerLimits;
  readonly #cache: AnalysisCache;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    stores: StoreRegistry,
    git: GitService,
    dataDir: string,
    limits: ServerLimits,
    cache: AnalysisCache,
  ) {
    this.#stores = stores;
    this.#git = git;
    this.#dataDir = dataDir;
    this.#limits = limits;
    this.#cache = cache;
  }

  sessionDir(user: string, sessionId: string): string {
    return path.join(this.#dataDir, 'users', user, 'sessions', sessionId);
  }

  #repoDir(user: string, sessionId: string, repoId: string) {
    return path.join(this.sessionDir(user, sessionId), 'repos', repoId);
  }

  /** Runs `task` after any earlier task with the same key (one git operation per repo at a time). */
  async #exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.#locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === run) this.#locks.delete(key);
    }
  }

  /** The user's own database, when they own the session (otherwise the session is not found). */
  #sessionStore(user: string, sessionId: string): Store {
    const store = this.#stores.read(user);
    if (store?.getSession(sessionId) === undefined) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }
    return store;
  }

  #requireSession(user: string, sessionId: string): void {
    this.#sessionStore(user, sessionId);
  }

  #requireRepo(user: string, sessionId: string, repoId: string): RepoRecord {
    const repo = this.#sessionStore(user, sessionId).getRepo(sessionId, repoId);
    if (!repo) throw new NotFoundError(`Repository not found in this session: ${repoId}`);
    return repo;
  }

  /** The repo's remote with this name, or a not-found error. */
  #requireRemote(repo: RepoRecord, name: string): void {
    if (!repo.remotes.some((remote) => remote.name === name)) {
      throw new NotFoundError(`Remote not found in this repository: ${name}`);
    }
  }

  /** Clones a repo into the session, or returns the existing clone. */
  async addRepo(
    user: string,
    sessionId: string,
    rawUrl: string,
  ): Promise<{ repo: RepoInfo; created: boolean }> {
    this.#requireSession(user, sessionId);
    const url = normalizeUrl(rawUrl);
    this.#git.validateUrl(url);

    // One add at a time per session: the count of repos and the clone are checked together.
    return await this.#exclusive(`${sessionId}:add`, async () => {
      const store = this.#sessionStore(user, sessionId);
      const existing = store.findRepoByUrl(sessionId, url);
      if (existing && existsSync(this.#repoDir(user, sessionId, existing.id))) {
        return { repo: toInfo(existing), created: false };
      }
      if (existing === undefined && store.countRepos(sessionId) >= this.#limits.reposPerSession) {
        throw new ConflictError(
          `This session already has ${this.#limits.reposPerSession} repositories. Remove one to add another.`,
        );
      }
      const id = existing?.id ?? crypto.randomUUID();
      const { defaultBranch, branches } = await this.#git.clone(
        url,
        this.#repoDir(user, sessionId, id),
      );
      const saved = store.saveRepo({
        id,
        sessionId,
        url,
        name: GitService.repoName(url),
        defaultBranch,
        branches,
      });
      store.touchSession(sessionId);
      return { repo: toInfo(saved), created: true };
    });
  }

  /** Fetches every remote of a repo. */
  async fetchRepo(user: string, sessionId: string, repoId: string): Promise<RepoInfo> {
    this.#requireSession(user, sessionId);
    const repo = this.#requireRepo(user, sessionId, repoId);
    return await this.#exclusive(`${sessionId}:${repo.url}`, async () => {
      const store = this.#sessionStore(user, sessionId);
      const repoDir = this.#repoDir(user, sessionId, repoId);
      for (const remote of repo.remotes) {
        const fetched = await this.#git.fetchRemote(repoDir, remote.name);
        store.saveRemoteFetch(repoId, remote.name, fetched);
      }
      return toInfo(this.#requireRepo(user, sessionId, repoId));
    });
  }

  /** Fetches one remote of a repo; the others are left as they were. */
  async fetchRemote(
    user: string,
    sessionId: string,
    repoId: string,
    name: string,
  ): Promise<RepoInfo> {
    this.#requireSession(user, sessionId);
    this.#requireRemote(this.#requireRepo(user, sessionId, repoId), name);
    const repo = this.#requireRepo(user, sessionId, repoId);
    return await this.#exclusive(`${sessionId}:${repo.url}`, async () => {
      const store = this.#sessionStore(user, sessionId);
      const fetched = await this.#git.fetchRemote(this.#repoDir(user, sessionId, repoId), name);
      store.saveRemoteFetch(repoId, name, fetched);
      return toInfo(this.#requireRepo(user, sessionId, repoId));
    });
  }

  /**
   * Adds another place the repo lives (a fork, a mirror) under its own name, and fetches it. Names and
   * URLs are unique within a repo, and the repo has at most `remotesPerRepo` remotes.
   */
  async addRemote(
    user: string,
    sessionId: string,
    repoId: string,
    request: AddRemoteRequest,
  ): Promise<RepoInfo> {
    this.#requireSession(user, sessionId);
    const url = normalizeUrl(request.url);
    this.#git.validateUrl(url);
    const { name } = request;
    const repo = this.#requireRepo(user, sessionId, repoId);

    return await this.#exclusive(`${sessionId}:${repo.url}`, async () => {
      const current = this.#requireRepo(user, sessionId, repoId);
      const sameName = current.remotes.find((remote) => remote.name === name);
      if (sameName !== undefined) {
        throw new ConflictError(`This repository already has a remote named "${name}"`);
      }
      const sameUrl = current.remotes.find((remote) => remote.url === url);
      if (sameUrl !== undefined) {
        throw new ConflictError(
          `This repository already has that URL, as remote "${sameUrl.name}"`,
        );
      }
      if (current.remotes.length >= this.#limits.remotesPerRepo) {
        throw new ConflictError(
          `This repository already has ${this.#limits.remotesPerRepo} remotes. Remove one to add another.`,
        );
      }
      const store = this.#sessionStore(user, sessionId);
      const fetched = await this.#git.addRemote(this.#repoDir(user, sessionId, repoId), name, url);
      store.addRemote(repoId, { name, url, ...fetched });
      store.touchSession(sessionId);
      return toInfo(this.#requireRepo(user, sessionId, repoId));
    });
  }

  /**
   * Removes one remote: its branches, tags and configuration. A repo keeps at least one remote; to
   * drop the last one, remove the repository.
   */
  async removeRemote(user: string, sessionId: string, repoId: string, name: string): Promise<void> {
    this.#requireSession(user, sessionId);
    this.#requireRemote(this.#requireRepo(user, sessionId, repoId), name);
    const repo = this.#requireRepo(user, sessionId, repoId);
    await this.#exclusive(`${sessionId}:${repo.url}`, async () => {
      const current = this.#requireRepo(user, sessionId, repoId);
      if (current.remotes.length <= 1) {
        throw new ConflictError(
          'A repository needs at least one remote. Remove the repository instead.',
        );
      }
      await this.#git.removeRemote(this.#repoDir(user, sessionId, repoId), name);
      this.#sessionStore(user, sessionId).deleteRemote(repoId, name);
      this.#sessionStore(user, sessionId).touchSession(sessionId);
      // Results may name commits only that remote had: they go with it.
      this.#cache.purgeRepo({ user, repoId });
    });
  }

  /** Whether one remote of a repo answers now, and git's reason when it does not. Reads only. */
  async checkRemote(
    user: string,
    sessionId: string,
    repoId: string,
    name: string,
  ): Promise<{ reachable: boolean; message: string }> {
    this.#requireSession(user, sessionId);
    this.#requireRemote(this.#requireRepo(user, sessionId, repoId), name);
    return await this.#git.checkRemote(this.#repoDir(user, sessionId, repoId), name);
  }

  /** Resolves a git side to its exact commit, on its remote (the clone's `origin` when none is named). */
  async resolveSnapshot(
    source: GitSource,
    user: string,
    sessionId: string,
  ): Promise<ResolvedSnapshot> {
    this.#requireSession(user, sessionId);
    const repo = this.#requireRepo(user, sessionId, source.repoId);
    const remote = source.remote ?? DEFAULT_REMOTE;
    if (!repo.remotes.some((r) => r.name === remote)) {
      throw new CompareInputError(`Remote "${remote}" is not in this repository`);
    }
    const repoDir = this.#repoDir(user, sessionId, repo.id);
    const commit = await this.#git.resolveCommit(repoDir, source.branch, remote);
    const name = remote === DEFAULT_REMOTE ? repo.name : `${repo.name} (${remote})`;
    return {
      repoDir,
      commit,
      ref: source.branch,
      remote,
      label: `${name} @ ${source.branch}`,
      cacheScope: { user, repoId: repo.id },
    };
  }

  async deleteSession(user: string, sessionId: string): Promise<boolean> {
    const store = this.#stores.read(user);
    for (const repo of store?.listRepos(sessionId) ?? []) {
      this.#cache.purgeRepo({ user, repoId: repo.id });
    }
    const isDeleted = store?.deleteSession(sessionId) ?? false;
    if (isDeleted) await rm(this.sessionDir(user, sessionId), { recursive: true, force: true });
    return isDeleted;
  }

  /**
   * Deletes a repo's clone first, then its row (so a failed disk delete leaves the repo
   * listed, and can be retried). Under the repo's lock, so no git operation is running in it.
   */
  async deleteRepo(user: string, sessionId: string, repoId: string): Promise<void> {
    this.#requireSession(user, sessionId);
    const repo = this.#requireRepo(user, sessionId, repoId);
    await this.#exclusive(`${sessionId}:${repo.url}`, async () => {
      const retry = { recursive: true, force: true, maxRetries: 5 } as const;
      const repoDir = this.#repoDir(user, sessionId, repoId);
      // Under the git lock too: no analysis command may be reading the clone while it goes.
      await this.#git.exclusive(repoDir, () => rm(repoDir, retry));
      if (!this.#sessionStore(user, sessionId).deleteRepo(sessionId, repoId)) {
        throw new NotFoundError(`Repository not found in this session: ${repoId}`);
      }
      this.#cache.purgeRepo({ user, repoId });
    });
  }

  /**
   * Removes clones and sessions that no row names: what a crash or an interrupted delete
   * leaves behind. Best effort: a folder that cannot be removed now (Windows may still hold it) is
   * tried again at the next start.
   */
  sweepOrphans(): void {
    const usersDir = path.join(this.#dataDir, 'users');
    if (!existsSync(usersDir)) return;
    for (const user of readdirSync(usersDir)) {
      if (!UsernameSchema.safeParse(user).success) continue;
      const store = this.#stores.read(user);
      const sessionsDir = path.join(usersDir, user, 'sessions');
      for (const sessionId of listDirs(sessionsDir)) {
        const session = store?.getSession(sessionId);
        const sessionPath = path.join(sessionsDir, sessionId);
        if (session === undefined) {
          removeQuietly(sessionPath);
          continue;
        }
        for (const repoId of listDirs(path.join(sessionPath, 'repos'))) {
          if (store?.getRepo(sessionId, repoId) === undefined) {
            removeQuietly(path.join(sessionPath, 'repos', repoId));
          }
        }
      }
    }
  }
}

/** The names of the folders directly inside `dir` (none when it does not exist). */
function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Still held by a process (Windows): the next start's sweep tries again.
  }
}
