import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  AddRepoRequestSchema,
  ApplicabilityRequestSchema,
  CommitPatchRequestSchema,
  CreateSessionRequestSchema,
  DirectoryCompareRequestSchema,
  FileCompareQuerySchema,
  SessionIdSchema,
  SnapshotFileDiffRequestSchema,
  UpstreamCommitsRequestSchema,
  UsernameSchema,
  type DefaultsResponse,
  type FileCompareResult,
  type SessionDetail,
  type UpstreamCommitList,
} from '@om/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, type ZodError, type ZodType } from 'zod';
import { compareDirectories } from './compare/compare-directories.ts';
import { filesEqual } from './compare/files-equal.ts';
import { CompareInputError, ConflictError, NotFoundError } from './errors.ts';
import { readFileForDiff } from './files/read-file.ts';
import { GitService } from './git/git-service.ts';
import { RepoManager, toInfo } from './git/repo-manager.ts';
import { annotateRenames } from './snapshot/annotate-renames.ts';
import { SnapshotAnalyzer } from './snapshot/snapshot-analyzer.ts';
import { Store } from './store/store.ts';
import { UpstreamAnalyzer } from './upstream/upstream-analyzer.ts';

/** Options for {@link buildApp}. All are optional; tests rely on the defaults. */
export type AppOptions = {
  /** Text files larger than this are not returned to the diff view. */
  maxTextFileBytes?: number;
  /** Directory with the built web app to serve (production). */
  staticDir?: string;
  logger?: boolean;
  /** Folders the UI compares when the user has not entered any. */
  defaultLeft?: string;
  defaultRight?: string;
  /** Where sessions, clones and the database live. Defaults to a fresh temp folder. */
  dataDir?: string;
  /** URL schemes allowed for cloning (default: https, ssh). */
  allowedProtocols?: string[];
  /** Where applicability analysis puts its temporary object directories. Default `<dataDir>/scratch`. */
  scratchDir?: string;
};

/** Route parameters, validated like any other input. */
const UserParamsSchema = z.object({ user: UsernameSchema });
const SessionParamsSchema = z.object({ user: UsernameSchema, sessionId: SessionIdSchema });
const RepoParamsSchema = SessionParamsSchema.extend({ repoId: z.string().min(1) });

/**
 * Aborted when the client goes away before the response is sent (navigated elsewhere,
 * cancelled the query), so long git analysis stops instead of running for nobody.
 */
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
    defaultLeft,
    defaultRight,
    dataDir = path.join(tmpdir(), `om-data-${crypto.randomUUID()}`),
    allowedProtocols,
  } = options;
  const { scratchDir = path.join(dataDir, 'scratch') } = options;
  const app = Fastify({ logger: isLogging });

  mkdirSync(dataDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'om.db'));
  const git = new GitService(allowedProtocols ? { allowedProtocols } : {});
  const repos = new RepoManager(store, git, dataDir);
  const snapshots = new SnapshotAnalyzer(git, {
    maxTextBytes: maxTextFileBytes,
    maxDiffLines: 20_000,
  });
  const upstream = new UpstreamAnalyzer(git, snapshots, { scratchDir });
  app.addHook('onClose', () => {
    store.close();
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
    const session = store.getSession(user, sessionId);
    if (session === undefined) throw new NotFoundError(`Session not found: ${sessionId}`);
    return {
      user,
      session,
      repos: store.listRepos(sessionId).map(toInfo),
      recent: store.listComparisons(sessionId),
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

  app.get('/api/defaults', (): DefaultsResponse => ({
    ...(defaultLeft !== undefined && defaultLeft !== '' ? { left: defaultLeft } : {}),
    ...(defaultRight !== undefined && defaultRight !== '' ? { right: defaultRight } : {}),
  }));

  app.get('/api/users/:user/sessions', (request) => {
    const { user } = parse(UserParamsSchema, request.params);
    return store.listSessions(user);
  });

  app.post('/api/users/:user/sessions', (request, reply) => {
    const { user } = parse(UserParamsSchema, request.params);
    const { name } = parse(CreateSessionRequestSchema, request.body);
    return reply.status(201).send(store.createSession(user, name));
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

  app.post('/api/users/:user/sessions/:sessionId/repos/:repoId/fetch', (request) => {
    const { user, sessionId, repoId } = parse(RepoParamsSchema, request.params);
    return repos.fetchRepo(user, sessionId, repoId);
  });

  app.post('/api/compare/directories', async (request) => {
    const { left, right, user, sessionId } = parse(DirectoryCompareRequestSchema, request.body);
    const [l, r] = await Promise.all([
      repos.resolve(left, user, sessionId),
      repos.resolve(right, user, sessionId),
    ]);
    const result = await compareDirectories(l.root, r.root, {
      leftLabel: l.label,
      rightLabel: r.label,
      ignoreAtRoot: { left: l.ignore, right: r.ignore },
    });
    if (l.snapshot) result.leftSnapshot = { commit: l.snapshot.commit, ref: l.snapshot.ref };
    if (r.snapshot) result.rightSnapshot = { commit: r.snapshot.commit, ref: r.snapshot.ref };
    if (l.snapshot && r.snapshot) {
      try {
        annotateRenames(result.root, await snapshots.renames(l.snapshot, r.snapshot));
      } catch (err) {
        // Renames are extra information; the comparison itself stands without them.
        request.log.warn({ err }, 'rename detection failed');
      }
    }
    if (
      user !== undefined &&
      user !== '' &&
      sessionId !== undefined &&
      sessionId !== '' &&
      store.getSession(user, sessionId) !== undefined
    ) {
      store.recordComparison(sessionId, { left, right, leftLabel: l.label, rightLabel: r.label });
    }
    return result;
  });

  app.post('/api/snapshot/file-diff', async (request, reply) => {
    const body = parse(SnapshotFileDiffRequestSchema, request.body);
    const [l, r] = await Promise.all([
      repos.resolveSnapshot(body.left, body.user, body.sessionId),
      repos.resolveSnapshot(body.right, body.user, body.sessionId),
    ]);
    return await snapshots.fileDiff(
      l,
      r,
      { leftPath: body.leftPath, rightPath: body.rightPath, isFullFile: body.fullFile },
      abortOnDisconnect(reply),
    );
  });

  app.post('/api/upstream/commits', async (request, reply): Promise<UpstreamCommitList> => {
    const body = parse(UpstreamCommitsRequestSchema, request.body);
    const [up, down] = await Promise.all([
      repos.resolveSnapshot(body.upstream, body.user, body.sessionId),
      repos.resolveSnapshot(body.downstream, body.user, body.sessionId),
    ]);
    const { commits, hasMore } = await upstream.commits(up, down, body, abortOnDisconnect(reply));
    return {
      upstream: { commit: up.commit, ref: up.ref },
      downstream: { commit: down.commit, ref: down.ref },
      upstreamLabel: up.label,
      downstreamLabel: down.label,
      commits,
      hasMore,
    };
  });

  app.post('/api/upstream/applicability', async (request, reply) => {
    const body = parse(ApplicabilityRequestSchema, request.body);
    const [up, down] = await Promise.all([
      repos.resolveSnapshot(body.upstream, body.user, body.sessionId),
      // Checked out so that, in a blob-less clone, downstream's file contents are local.
      repos.resolveSnapshot(body.downstream, body.user, body.sessionId, { shouldCheckOut: true }),
    ]);
    return await upstream.applicability(up, down, body.commit, abortOnDisconnect(reply));
  });

  app.post('/api/upstream/patch', async (request, reply) => {
    const body = parse(CommitPatchRequestSchema, request.body);
    const up = await repos.resolveSnapshot(body.upstream, body.user, body.sessionId);
    return await upstream.patch(up, body.commit, abortOnDisconnect(reply));
  });

  app.get('/api/compare/files', async (request, reply) => {
    const parsed = FileCompareQuerySchema.safeParse(request.query);
    if (!parsed.success) return await reply.status(400).send({ message: zodMessage(parsed.error) });
    const { left, right } = parsed.data;

    const [l, r] = await Promise.all([
      left === undefined ? undefined : readFileForDiff(left, maxTextFileBytes),
      right === undefined ? undefined : readFileForDiff(right, maxTextFileBytes),
    ]);
    const result: FileCompareResult = {
      identical: left !== undefined && right !== undefined && (await filesEqual(left, right)),
    };
    if (l) result.left = l;
    if (r) result.right = r;
    return result;
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
