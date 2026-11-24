import { z } from 'zod';
import type {
  RemoteCheck,
  FolderComparison,
  RemoteInfo,
  ServerInfo,
  CommitInfo,
  CommitPatch,
  GitLog,
  GitTree,
  GitTreeNode,
  CompareNode,
  EntryInfo,
  RepoInfo,
  SessionDetail,
  SessionSummary,
  SnapshotFileDiff,
  SnapshotInfo,
  GitCherryPick,
  CherryPickStep,
  GitContains,
  GitFile,
  GitFiles,
  GitGrep,
  GitPatchIds,
  GitRefEntry,
  GitRefs,
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

/** `POST /api/git/diff`: one file's hunks between two git sides. */
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

export const GitTreeNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['directory', 'file', 'symlink', 'submodule']),
  oid: z.string(),
}) satisfies z.ZodType<GitTreeNode>;

export const GitTreeSchema = z.object({
  commit: z.string(),
  path: z.string(),
  entries: z.array(GitTreeNodeSchema),
}) satisfies z.ZodType<GitTree>;
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
      commit: CommitInfoSchema.extend({
        parents: z.array(z.string()),
        body: z.string().exactOptional(),
      }),
      mark: z.enum(['left', 'right', 'equivalent']),
    }),
  ),
  truncated: z.boolean().exactOptional(),
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

const GitRefEntrySchema = z.object({
  remote: z.string(),
  kind: z.enum(['branch', 'tag']),
  name: z.string(),
  commit: z.string(),
  commitDate: z.string(),
  subject: z.string(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<GitRefEntry>;

/** `POST /api/git/files`. */
export const GitFilesSchema = z.object({
  commit: z.string(),
  paths: z.array(z.string()),
  truncated: z.boolean(),
}) satisfies z.ZodType<GitFiles>;

/** `POST /api/git/file`. */
export const GitFileSchema = z.object({
  commit: z.string(),
  path: z.string(),
  oid: z.string(),
  size: z.number().int().nonnegative(),
  content: z.enum(['text', 'binary', 'too-large']),
  text: z.string().exactOptional(),
}) satisfies z.ZodType<GitFile>;

const GitGrepLineSchema = z.object({ line: z.number().int().positive(), text: z.string() });

/** `POST /api/git/grep`. */
export const GitGrepSchema = z.object({
  commit: z.string(),
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      text: z.string(),
      before: z.array(GitGrepLineSchema),
      after: z.array(GitGrepLineSchema),
    }),
  ),
  truncated: z.boolean(),
}) satisfies z.ZodType<GitGrep>;

/** `POST /api/git/refs`. */
export const GitRefsSchema = z.object({
  refs: z.array(GitRefEntrySchema),
  compareTo: GitRevisionSchema.exactOptional(),
}) satisfies z.ZodType<GitRefs>;

/** `POST /api/git/contains`. */
export const GitContainsSchema = z.object({
  commit: z.string(),
  refs: z.array(
    z.object({ remote: z.string(), kind: z.enum(['branch', 'tag']), name: z.string() }),
  ),
}) satisfies z.ZodType<GitContains>;

/** `POST /api/git/patch-ids`. */
export const GitPatchIdsSchema = z.object({
  results: z.array(z.object({ commit: z.string(), patchId: z.string().nullable() })),
}) satisfies z.ZodType<GitPatchIds>;

const CherryPickStepSchema = z.object({
  index: z.number().int().nonnegative(),
  commit: CommitInfoSchema.extend({ parents: z.array(z.string()) }),
  status: z.enum(['applies', 'no-change', 'in-history', 'conflict', 'not-run']),
  files: z.array(z.string()),
  conflictedPaths: z.array(z.string()),
  conflictedFiles: z.array(z.object({ path: z.string(), text: z.string().nullable() })),
  messages: z.array(z.string()),
}) satisfies z.ZodType<CherryPickStep>;

/** `POST /api/git/cherry-pick`. */
export const GitCherryPickSchema = z.object({
  onto: GitRevisionSchema,
  outcome: z.enum(['applies', 'conflict', 'invalid']),
  stoppedAt: z.number().int().nonnegative().exactOptional(),
  issues: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      commit: z.string(),
      problem: z.enum(['not-found', 'not-a-commit', 'duplicate', 'merge', 'root']),
      message: z.string(),
    }),
  ),
  warnings: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      kind: z.literal('parent-after-child'),
      message: z.string(),
    }),
  ),
  steps: z.array(CherryPickStepSchema),
  changedPaths: z.array(z.string()),
}) satisfies z.ZodType<GitCherryPick>;
