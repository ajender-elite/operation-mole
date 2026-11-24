import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  AddRemoteRequestSchema,
  AddRepoRequestSchema,
  RemoteNameSchema,
  CreateSessionRequestSchema,
  type GitAncestry,
  GitAncestryRequestSchema,
  type GitBlame,
  GitBlameRequestSchema,
  type GitCompareTrees,
  GitCompareTreesRequestSchema,
  type GitDiff,
  GitDiffRequestSchema,
  type GitLog,
  GitLogRequestSchema,
  type GitMergeBase,
  GitMergeBaseRequestSchema,
  type GitTree,
  GitTreeRequestSchema,
  type GitFiles,
  GitFilesRequestSchema,
  type GitFile,
  GitFileRequestSchema,
  type GitGrep,
  GitGrepRequestSchema,
  type GitRefs,
  GitRefsRequestSchema,
  type GitContains,
  GitContainsRequestSchema,
  type GitPatchIds,
  GitPatchIdsRequestSchema,
  type GitCherryPick,
  GitCherryPickRequestSchema,
  type GitMergeTree,
  type GitPatchEquivalents,
  GitPatchEquivalentsRequestSchema,
  GitMergeTreeRequestSchema,
  type GitResolve,
  GitResolveRequestSchema,
  type GitRevision,
  GitShowRequestSchema,
  type ServerInfo,
  type ServerLimits,
  type SessionDetail,
  SessionIdSchema,
  UsernameSchema,
} from '@om/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, type ZodError, type ZodType } from 'zod';
import { StoreCacheStorage } from './cache/store-cache-storage.ts';
import { TieredAnalysisCache } from './cache/analysis-cache.ts';
import { DEFAULT_LIMITS } from './config/server-config.ts';
import { CompareInputError, ConflictError, NotFoundError } from './errors.ts';
import { GitPrimitives } from './git-api/primitives.ts';
import { readLog } from './git-api/log.ts';
import { GitService } from './git/git-service.ts';
import { RepoManager, toInfo } from './git/repo-manager.ts';
import { SnapshotAnalyzer } from './snapshot/snapshot-analyzer.ts';
import { StoreRegistry } from './store/store-registry.ts';
import { CommitPatchReader } from './git-api/commit-patch.ts';

/** Options for {@link buildApp}. All are optional; tests rely on the defaults. */
export type AppOptions = {
  /** Text files larger than this are not returned to the diff view. */
  maxTextFileBytes?: number;
  /** Directory with the built web app to serve (production). */
  staticDir?: string;
  logger?: boolean;
  /** Where sessions, clones and the database live. Defaults to a fresh temp folder. */
  dataDir?: string;
  /** URL schemes allowed for cloning (default: https, ssh). */
  allowedProtocols?: string[];
  /** Where merge-tree puts its temporary object directories. Default `<dataDir>/scratch`. */
  scratchDir?: string;
  /** Limits on sessions, repos and remotes. Unset ones take the defaults (10 each). */
  limits?: Partial<ServerLimits>;
  /** Most cached analysis results each user keeps, in bytes. Default 256 MB. */
  cacheMaxBytes?: number;
};

/** Route parameters, validated like any other input. */
const UserParamsSchema = z.object({ user: UsernameSchema });
const SessionParamsSchema = z.object({ user: UsernameSchema, sessionId: SessionIdSchema });
const RepoParamsSchema = SessionParamsSchema.extend({ repoId: z.string().min(1) });
const RemoteParamsSchema = RepoParamsSchema.extend({ remote: RemoteNameSchema });

/**
 * Aborted when the client goes away before the response is sent (navigated elsewhere,
 * cancelled the query), so long git analysis stops instead of running for nobody.
 */
/** The revision a primitive resolved, as the API reports it. */
function revisionOf(snapshot: { commit: string; ref: string; label: string }): GitRevision {
  return { commit: snapshot.commit, ref: snapshot.ref, label: snapshot.label };
}

function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** HTTP status carried by Fastify's own errors (e.g. 415 for a bad content type), else 500. */
function statusCodeOf(error: unknown): number {
  return typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
    ? error.statusCode
    : 500;
}

const zodMessage = (err: ZodError): string =>
  err.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');

/**
 * Builds the Fastify app with every API route and the error mapping
 * (CompareInputError → 400, NotFoundError → 404, ConflictError → 409).
 * Does not listen; call `listen` (server) or `inject` (tests) on the result.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const {
    maxTextFileBytes = 5 * 1024 * 1024,
    staticDir,
    logger: isLogging = false,
    dataDir = path.join(tmpdir(), `om-data-${crypto.randomUUID()}`),
    allowedProtocols,
    cacheMaxBytes = 256 * 1024 * 1024,
  } = options;
  const { scratchDir = path.join(dataDir, 'scratch') } = options;
  const app = Fastify({ logger: isLogging });

  mkdirSync(dataDir, { recursive: true });
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const stores = new StoreRegistry(dataDir, { maxSessions: limits.sessionsPerUser });
  const git = new GitService(allowedProtocols ? { allowedProtocols } : {});
  const cache = new TieredAnalysisCache(new StoreCacheStorage(stores, cacheMaxBytes));
  const repos = new RepoManager(stores, git, dataDir, limits, cache);
  const snapshots = new SnapshotAnalyzer(
    git,
    { maxTextBytes: maxTextFileBytes, maxDiffLines: 20_000 },
    cache,
  );
  const patches = new CommitPatchReader(git);
  const primitives = new GitPrimitives(git, snapshots, { scratchDir, cache });
  // Folders that no row names (left by a crash or an interrupted delete) go before anything is served.
  repos.sweepOrphans();
  app.addHook('onClose', () => {
    stores.close();
  });

  /** Validates `value` or throws a 400 with zod's message. */
  const parse = <T>(schema: ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CompareInputError(zodMessage(parsed.error));
    return parsed.data;
  };

  const sessionParams = (request: FastifyRequest): z.infer<typeof SessionParamsSchema> =>
    parse(SessionParamsSchema, request.params);

  const sessionDetail = (user: string, sessionId: string): SessionDetail => {
    const store = stores.read(user);
    const session = store?.getSession(sessionId);
    if (store === undefined || session === undefined) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }
    return {
      user,
      session,
      repos: store.listRepos(sessionId).map(toInfo),
    };
  };

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof CompareInputError) return reply.status(400).send({ message: err.message });
    if (err instanceof NotFoundError) return reply.status(404).send({ message: err.message });
    if (err instanceof ConflictError) return reply.status(409).send({ message: err.message });
    request.log.error(err);
    return reply
      .status(statusCodeOf(err))
      .send({ message: err instanceof Error ? err.message : 'Internal error' });
  });

  // What the server's git can do and how it reaches remotes. No URLs, credentials or env values.
  let gitVersion: Promise<string> | undefined;
  app.get('/api/server', async (): Promise<ServerInfo> => {
    gitVersion ??= git.version();
    return {
      git: { version: await gitVersion },
      access: {
        protocols: git.allowedProtocols,
        isInteractive: false,
        hasSshAgent: git.sshAgentAvailable(),
      },
      limits,
    };
  });

  app.get('/api/users/:user/sessions', (request) => {
    const { user } = parse(UserParamsSchema, request.params);
    return stores.read(user)?.listSessions() ?? [];
  });

  app.post('/api/users/:user/sessions', (request, reply) => {
    const { user } = parse(UserParamsSchema, request.params);
    const { name } = parse(CreateSessionRequestSchema, request.body);
    return reply.status(201).send(stores.write(user).createSession(name));
  });

  app.get('/api/users/:user/sessions/:sessionId', (request) => {
    const { user, sessionId } = sessionParams(request);
    return sessionDetail(user, sessionId);
  });

  app.delete('/api/users/:user/sessions/:sessionId', async (request, reply) => {
    const { user, sessionId } = sessionParams(request);
    if (!(await repos.deleteSession(user, sessionId))) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }
    return await reply.status(204).send();
  });

  app.post('/api/users/:user/sessions/:sessionId/repos', async (request, reply) => {
    const { user, sessionId } = sessionParams(request);
    const { url } = parse(AddRepoRequestSchema, request.body);
    const { repo, created: isCreated } = await repos.addRepo(user, sessionId, url);
    return await reply.status(isCreated ? 201 : 200).send(repo);
  });

  app.delete('/api/users/:user/sessions/:sessionId/repos/:repoId', async (request, reply) => {
    const { user, sessionId, repoId } = parse(RepoParamsSchema, request.params);
    await repos.deleteRepo(user, sessionId, repoId);
    return await reply.status(204).send();
  });

  app.post('/api/users/:user/sessions/:sessionId/repos/:repoId/remotes', async (request, reply) => {
    const { user, sessionId, repoId } = parse(RepoParamsSchema, request.params);
    const body = parse(AddRemoteRequestSchema, request.body);
    return await reply.status(201).send(await repos.addRemote(user, sessionId, repoId, body));
  });

  app.post(
    '/api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote/fetch',
    (request) => {
      const { user, sessionId, repoId, remote } = parse(RemoteParamsSchema, request.params);
      return repos.fetchRemote(user, sessionId, repoId, remote);
    },
  );

  app.post(
    '/api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote/check',
    (request) => {
      const { user, sessionId, repoId, remote } = parse(RemoteParamsSchema, request.params);
      return repos.checkRemote(user, sessionId, repoId, remote);
    },
  );

  app.delete(
    '/api/users/:user/sessions/:sessionId/repos/:repoId/remotes/:remote',
    async (request, reply) => {
      const { user, sessionId, repoId, remote } = parse(RemoteParamsSchema, request.params);
      await repos.removeRemote(user, sessionId, repoId, remote);
      return await reply.status(204).send();
    },
  );

  app.post('/api/users/:user/sessions/:sessionId/repos/:repoId/fetch', (request) => {
    const { user, sessionId, repoId } = parse(RepoParamsSchema, request.params);
    return repos.fetchRepo(user, sessionId, repoId);
  });

  app.post('/api/git/log', async (request, reply): Promise<GitLog> => {
    const body = parse(GitLogRequestSchema, request.body);
    const include = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    const exclude =
      body.exclude === undefined
        ? undefined
        : await repos.resolveSnapshot(body.exclude, body.user, body.sessionId);
    const page = await readLog(git, include, exclude, body, abortOnDisconnect(reply));
    return {
      include: revisionOf(include),
      ...(exclude === undefined ? {} : { exclude: revisionOf(exclude) }),
      ...page,
    };
  });

  app.post('/api/git/show', async (request, reply) => {
    const body = parse(GitShowRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    return await patches.patch(snapshot, snapshot.commit, abortOnDisconnect(reply));
  });

  app.post('/api/git/resolve', async (request): Promise<GitResolve> => {
    const body = parse(GitResolveRequestSchema, request.body);
    const snapshots = await Promise.all(
      body.sources.map((source) => repos.resolveSnapshot(source, body.user, body.sessionId)),
    );
    return { revisions: snapshots.map(revisionOf) };
  });

  app.post('/api/git/merge-base', async (request, reply): Promise<GitMergeBase> => {
    const body = parse(GitMergeBaseRequestSchema, request.body);
    const [a, b] = await Promise.all([
      repos.resolveSnapshot(body.a, body.user, body.sessionId),
      repos.resolveSnapshot(body.b, body.user, body.sessionId),
    ]);
    return { commit: await primitives.mergeBase(a, b, abortOnDisconnect(reply)) };
  });

  app.post('/api/git/tree', async (request, reply): Promise<GitTree> => {
    const body = parse(GitTreeRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    return await primitives.tree(snapshot, body.path ?? '', abortOnDisconnect(reply));
  });

  app.post('/api/git/files', async (request, reply): Promise<GitFiles> => {
    const body = parse(GitFilesRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    return await primitives.files(snapshot, abortOnDisconnect(reply));
  });

  app.post('/api/git/file', async (request, reply): Promise<GitFile> => {
    const body = parse(GitFileRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    return await primitives.file(snapshot, body.path, abortOnDisconnect(reply));
  });

  app.post('/api/git/grep', async (request, reply): Promise<GitGrep> => {
    const body = parse(GitGrepRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    return await primitives.grep(
      snapshot,
      {
        query: body.query,
        regex: body.regex,
        ignoreCase: body.ignoreCase,
        paths: body.paths,
        context: body.context,
      },
      abortOnDisconnect(reply),
    );
  });

  app.post('/api/git/refs', async (request, reply): Promise<GitRefs> => {
    const body = parse(GitRefsRequestSchema, request.body);
    const location = repos.repoLocation(body.user, body.sessionId, body.repoId);
    const compareTo =
      body.compareTo === undefined
        ? undefined
        : await repos.resolveSnapshot(body.compareTo, body.user, body.sessionId);
    return await primitives.refs(location, compareTo, abortOnDisconnect(reply));
  });

  app.post('/api/git/contains', async (request, reply): Promise<GitContains> => {
    const body = parse(GitContainsRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    return await primitives.contains(snapshot, abortOnDisconnect(reply));
  });

  app.post('/api/git/patch-ids', async (request, reply): Promise<GitPatchIds> => {
    const body = parse(GitPatchIdsRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    return await primitives.patchIds(snapshot, body.commits, abortOnDisconnect(reply));
  });

  app.post('/api/git/cherry-pick', async (request, reply): Promise<GitCherryPick> => {
    const body = parse(GitCherryPickRequestSchema, request.body);
    const onto = await repos.resolveSnapshot(body.onto, body.user, body.sessionId);
    return await primitives.cherryPick(onto, body.commits, abortOnDisconnect(reply));
  });

  app.post('/api/git/ancestry', async (request, reply): Promise<GitAncestry> => {
    const body = parse(GitAncestryRequestSchema, request.body);
    const tip = await repos.resolveSnapshot(body.tip, body.user, body.sessionId);
    return { results: await primitives.ancestry(tip, body.commits, abortOnDisconnect(reply)) };
  });

  app.post('/api/git/blame', async (request, reply): Promise<GitBlame> => {
    const body = parse(GitBlameRequestSchema, request.body);
    const snapshot = await repos.resolveSnapshot(body.source, body.user, body.sessionId);
    const blame = await primitives.blame(snapshot, body.path, body.lines, abortOnDisconnect(reply));
    return { path: body.path, commit: snapshot.commit, ...blame };
  });

  app.post('/api/git/diff', async (request, reply): Promise<GitDiff> => {
    const body = parse(GitDiffRequestSchema, request.body);
    const [left, right] = await Promise.all([
      repos.resolveSnapshot(body.left, body.user, body.sessionId),
      repos.resolveSnapshot(body.right, body.user, body.sessionId),
    ]);
    const files = await primitives.diff(
      left,
      right,
      body.files,
      body.fullFile,
      abortOnDisconnect(reply),
    );
    return { files };
  });

  app.post('/api/git/merge-tree', async (request, reply): Promise<GitMergeTree> => {
    const body = parse(GitMergeTreeRequestSchema, request.body);
    const [ours, theirs] = await Promise.all([
      repos.resolveSnapshot(body.ours, body.user, body.sessionId),
      repos.resolveSnapshot(body.theirs, body.user, body.sessionId),
    ]);
    const base =
      body.base === undefined
        ? undefined
        : await repos.resolveSnapshot(body.base, body.user, body.sessionId);
    const merge = await primitives.mergeTree(ours, theirs, base, abortOnDisconnect(reply));
    return { ours: revisionOf(ours), theirs: revisionOf(theirs), ...merge };
  });

  app.post('/api/git/patch-equivalents', async (request, reply): Promise<GitPatchEquivalents> => {
    const body = parse(GitPatchEquivalentsRequestSchema, request.body);
    const [left, right] = await Promise.all([
      repos.resolveSnapshot(body.left, body.user, body.sessionId),
      repos.resolveSnapshot(body.right, body.user, body.sessionId),
    ]);
    const exclude =
      body.exclude === undefined
        ? undefined
        : await repos.resolveSnapshot(body.exclude, body.user, body.sessionId);
    const comparison = await primitives.patchEquivalents(
      left,
      right,
      exclude,
      { withBody: body.withBody, limit: body.limit },
      abortOnDisconnect(reply),
    );
    return {
      left: revisionOf(left),
      right: revisionOf(right),
      ...(exclude === undefined ? {} : { exclude: revisionOf(exclude) }),
      commits: comparison.commits,
      ...(comparison.truncated ? { truncated: true } : {}),
    };
  });

  app.post('/api/git/compare-trees', async (request, reply): Promise<GitCompareTrees> => {
    const body = parse(GitCompareTreesRequestSchema, request.body);
    const [left, right] = await Promise.all([
      repos.resolveSnapshot(body.left, body.user, body.sessionId),
      repos.resolveSnapshot(body.right, body.user, body.sessionId),
    ]);
    const trees = await primitives.compareTrees(left, right, body.paths, abortOnDisconnect(reply));
    return { left: revisionOf(left), right: revisionOf(right), ...trees };
  });

  if (staticDir !== undefined && staticDir !== '') {
    void app.register(fastifyStatic, { root: staticDir });
    // Client-side routing: unknown non-API GETs get the SPA entry point.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ message: `Not found: ${request.url}` });
    });
  }

  return app;
}
