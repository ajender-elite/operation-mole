import { z } from 'zod';
import type {
  RemoteCheck,
  FolderComparison,
  RemoteInfo,
  ServerInfo,
  ApplicabilityResult,
  CommitInfo,
  CommitPatch,
  GitLog,
  CompareNode,
  EntryInfo,
  RepoInfo,
  SessionDetail,
  SessionSummary,
  SnapshotFileDiff,
  SnapshotInfo,
  UpstreamCommitList,
} from './api.ts';

/*
 * Schemas for API responses, so the web client validates what the network returns instead of
 * trusting it (CONTRIBUTING.md §7.6). Each one is pinned to its type in api.ts with
 * `satisfies` (or an annotation, for the recursive tree), so the two cannot drift apart.
 */

const EntryInfoSchema = z.object({
  kind: z.enum(['file', 'directory', 'symlink']),
  size: z.number(),
  mtimeMs: z.number(),
  linkTarget: z.string().exactOptional(),
}) satisfies z.ZodType<EntryInfo>;

/** One node of a folder comparison, with its children. */
export const CompareNodeSchema: z.ZodType<CompareNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    status: z.enum(['identical', 'modified', 'only-left', 'only-right', 'error']),
    left: EntryInfoSchema.exactOptional(),
    right: EntryInfoSchema.exactOptional(),
    children: z.array(CompareNodeSchema).exactOptional(),
    error: z.string().exactOptional(),
    renamedTo: z.string().exactOptional(),
    renamedFrom: z.string().exactOptional(),
    similarity: z.number().exactOptional(),
  }),
);

const SnapshotInfoSchema = z.object({
  commit: z.string(),
  ref: z.string(),
}) satisfies z.ZodType<SnapshotInfo>;

/** One session, as listed or created. */
export const SessionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  repoCount: z.number(),
}) satisfies z.ZodType<SessionSummary>;

/** `GET /api/users/:user/sessions`. */
export const SessionSummaryListSchema = z.array(SessionSummarySchema);

/** One remote of a repo. */
export const RemoteCheckSchema = z.object({
  reachable: z.boolean(),
  message: z.string(),
}) satisfies z.ZodType<RemoteCheck>;

export const RemoteInfoSchema = z.object({
  name: z.string(),
  url: z.string(),
  defaultBranch: z.string(),
  branches: z.array(z.string()),
  fetchedAt: z.string(),
}) satisfies z.ZodType<RemoteInfo>;

/** A cloned repo (add, fetch, and inside session details). */
export const RepoInfoSchema = z.object({
  id: z.string(),
  remotes: z.array(RemoteInfoSchema),
  url: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  branches: z.array(z.string()),
  fetchedAt: z.string(),
}) satisfies z.ZodType<RepoInfo>;

/** `GET /api/users/:user/sessions/:sessionId`. */
export const ServerInfoSchema = z.object({
  git: z.object({ version: z.string() }),
  access: z.object({
    protocols: z.array(z.string()),
    isInteractive: z.boolean(),
    hasSshAgent: z.boolean(),
  }),
  limits: z.object({
    sessionsPerUser: z.number().int().positive(),
    reposPerSession: z.number().int().positive(),
    remotesPerRepo: z.number().int().positive(),
  }),
}) satisfies z.ZodType<ServerInfo>;

export const SessionDetailSchema = z.object({
  user: z.string(),
  session: SessionSummarySchema,
  repos: z.array(RepoInfoSchema),
}) satisfies z.ZodType<SessionDetail>;

const CommitInfoSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authorDate: z.string(),
  committerName: z.string(),
  committerEmail: z.string(),
  commitDate: z.string(),
}) satisfies z.ZodType<CommitInfo>;

const DiffHunkSchema = z.object({
  header: z.string(),
  leftStart: z.number(),
  leftCount: z.number(),
  rightStart: z.number(),
  rightCount: z.number(),
  lines: z.array(
    z.object({
      kind: z.enum(['context', 'removed', 'added']),
      text: z.string(),
      leftLine: z.number().exactOptional(),
      rightLine: z.number().exactOptional(),
      commit: z.string().exactOptional(),
    }),
  ),
});

/** `POST /api/snapshot/file-diff`. */
export const SnapshotFileDiffSchema = z.object({
  leftCommit: z.string(),
  rightCommit: z.string(),
  leftPath: z.string().exactOptional(),
  rightPath: z.string().exactOptional(),
  content: z.enum(['text', 'identical', 'binary', 'too-large']),
  hunks: z.array(DiffHunkSchema),
  commits: z.array(
    CommitInfoSchema.extend({
      inLeft: z.boolean().nullable(),
      inRight: z.boolean().nullable(),
    }),
  ),
  attributionNote: z.string().exactOptional(),
  truncated: z.boolean().exactOptional(),
}) satisfies z.ZodType<SnapshotFileDiff>;

/** `POST /api/upstream/commits`. */
export const UpstreamCommitListSchema = z.object({
  upstream: SnapshotInfoSchema,
  downstream: SnapshotInfoSchema,
  upstreamLabel: z.string(),
  downstreamLabel: z.string(),
  commits: z.array(
    CommitInfoSchema.extend({
      parents: z.array(z.string()),
      reachableFromDownstream: z.boolean(),
    }),
  ),
  hasMore: z.boolean(),
}) satisfies z.ZodType<UpstreamCommitList>;

/** `POST /api/upstream/applicability`. */
export const ApplicabilityResultSchema = z.object({
  commit: z.string(),
  downstreamCommit: z.string(),
  status: z.enum(['clean', 'represented', 'conflict', 'unknown']),
  reason: z.enum([
    'reachable',
    'equivalent-patch',
    'no-effective-change',
    'applies',
    'conflict',
    'error',
  ]),
  baseParent: z.string().exactOptional(),
  isMerge: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().exactOptional(),
      outcome: z.enum(['applies', 'already-present', 'conflict']),
    }),
  ),
  equivalentCommits: z.array(CommitInfoSchema),
  conflicts: z.array(
    z.object({ path: z.string(), startLine: z.number(), lines: z.array(z.string()) }),
  ),
  messages: z.array(z.string()),
  detail: z.string().exactOptional(),
}) satisfies z.ZodType<ApplicabilityResult>;

/** `POST /api/upstream/patch`. */
const GitRevisionSchema = z.object({
  commit: z.string(),
  ref: z.string(),
  label: z.string(),
});

const GitLogFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});

/** Response of `POST /api/git/log`. See {@link GitLog}. */
export const GitLogSchema = z.object({
  include: GitRevisionSchema,
  exclude: GitRevisionSchema.optional(),
  commits: z.array(
    CommitInfoSchema.extend({
      parents: z.array(z.string()),
      body: z.string().optional(),
      files: z.array(GitLogFileSchema).optional(),
    }),
  ),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
  excludeIsAncestor: z.boolean().optional(),
}) satisfies z.ZodType<GitLog>;

const GitBlameLineSchema = z.object({
  line: z.number().int().positive(),
  commit: z.string(),
  origLine: z.number().int().positive(),
  origPath: z.string().optional(),
  boundary: z.boolean(),
});

const GitTreeLeafSchema = z.object({
  kind: z.enum(['file', 'symlink', 'submodule']),
  oid: z.string(),
  size: z.number().int().nonnegative(),
});

export const GitResolveSchema = z.object({ revisions: z.array(GitRevisionSchema) });
export const GitMergeBaseSchema = z.object({ commit: z.string().nullable() });
export const GitAncestrySchema = z.object({
  results: z.array(z.object({ commit: z.string(), isAncestor: z.boolean().nullable() })),
});
export const GitBlameSchema = z.object({
  path: z.string(),
  commit: z.string(),
  lines: z.array(GitBlameLineSchema),
  commits: z.array(CommitInfoSchema),
});
export const GitDiffSchema = z.object({ files: z.array(SnapshotFileDiffSchema) });
export const GitPatchEquivalentsSchema = z.object({
  left: GitRevisionSchema,
  right: GitRevisionSchema,
  exclude: GitRevisionSchema.optional(),
  commits: z.array(
    z.object({
      commit: CommitInfoSchema.extend({ parents: z.array(z.string()) }),
      mark: z.enum(['left', 'right', 'equivalent']),
    }),
  ),
});

export const GitMergeTreeSchema = z.object({
  ours: GitRevisionSchema,
  theirs: GitRevisionSchema,
  base: z.string().nullable(),
  isClean: z.boolean(),
  conflictedPaths: z.array(z.string()),
  conflictedFiles: z.array(z.object({ path: z.string(), text: z.string().nullable() })),
  changedPaths: z.array(z.string()),
  messages: z.array(z.string()),
});
/** The folder tree of two git sides (`GitCompareTrees.folder`). */
export const FolderComparisonSchema = z.object({
  leftLabel: z.string(),
  rightLabel: z.string(),
  root: CompareNodeSchema,
  summary: z.object({
    identical: z.number(),
    modified: z.number(),
    onlyLeft: z.number(),
    onlyRight: z.number(),
    errors: z.number(),
  }),
  leftSnapshot: SnapshotInfoSchema.exactOptional(),
  rightSnapshot: SnapshotInfoSchema.exactOptional(),
}) satisfies z.ZodType<FolderComparison>;

/** `POST /api/git/compare-trees`. */
export const GitCompareTreesSchema = z.object({
  left: GitRevisionSchema,
  right: GitRevisionSchema,
  entries: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['identical', 'modified', 'only-left', 'only-right']),
      left: GitTreeLeafSchema.optional(),
      right: GitTreeLeafSchema.optional(),
    }),
  ),
  renames: z.array(z.object({ from: z.string(), to: z.string(), similarity: z.number() })),
  folder: FolderComparisonSchema,
});

export const CommitPatchSchema = z.object({
  commit: z.string(),
  details: CommitInfoSchema.extend({ parents: z.array(z.string()) }),
  baseParent: z.string().exactOptional(),
  files: z.array(
    z.object({
      oldPath: z.string().exactOptional(),
      newPath: z.string().exactOptional(),
      status: z.enum(['added', 'deleted', 'modified', 'renamed', 'other']),
      binary: z.boolean(),
      hunks: z.array(DiffHunkSchema),
    }),
  ),
  truncated: z.boolean(),
}) satisfies z.ZodType<CommitPatch>;
