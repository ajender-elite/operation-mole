import { z } from 'zod';
import type {
  ApplicabilityResult,
  CommitInfo,
  CommitPatch,
  CompareNode,
  DirectoryCompareResult,
  EntryInfo,
  FileCompareResult,
  FileContent,
  RecentComparison,
  RepoInfo,
  SessionDetail,
  SessionSummary,
  SnapshotFileDiff,
  SnapshotInfo,
  UpstreamCommitList,
} from './api.ts';
import { SourceSchema } from './schemas.ts';

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

/** `POST /api/compare/directories`. */
export const DirectoryCompareResultSchema = z.object({
  left: z.string(),
  right: z.string(),
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
}) satisfies z.ZodType<DirectoryCompareResult>;

const FileContentSchema = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string(),
  binary: z.boolean(),
  content: z.string().exactOptional(),
  tooLarge: z.boolean().exactOptional(),
}) satisfies z.ZodType<FileContent>;

/** `GET /api/compare/files`. */
export const FileCompareResultSchema = z.object({
  left: FileContentSchema.exactOptional(),
  right: FileContentSchema.exactOptional(),
  identical: z.boolean(),
}) satisfies z.ZodType<FileCompareResult>;

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

/** A cloned repo (add, fetch, and inside session details). */
export const RepoInfoSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  branches: z.array(z.string()),
  fetchedAt: z.string(),
}) satisfies z.ZodType<RepoInfo>;

const RecentComparisonSchema = z.object({
  id: z.string(),
  left: SourceSchema,
  right: SourceSchema,
  leftLabel: z.string(),
  rightLabel: z.string(),
  comparedAt: z.string(),
}) satisfies z.ZodType<RecentComparison>;

/** `GET /api/users/:user/sessions/:sessionId`. */
export const SessionDetailSchema = z.object({
  user: z.string(),
  session: SessionSummarySchema,
  repos: z.array(RepoInfoSchema),
  recent: z.array(RecentComparisonSchema),
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
