import { z } from 'zod';

/** Absolute on any OS: `/…` (Linux, macOS), `C:\…` or `C:/…`, or a Windows share `\\server\share…`. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

const absolutePath = z
  .string()
  .trim()
  .min(1, 'Path is required')
  .refine((p) => ABSOLUTE_PATH.test(p), 'Path must be absolute');

/** Usernames double as folder names on disk, so keep them to a safe character set. */
export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,31}$/,
    'Use 1–32 letters, digits, dots, dashes or underscores, starting with a letter or digit',
  );

/** Session ids are generated UUIDs; they also name folders on disk. */
export const SessionIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/, 'Invalid session id');

/** Body of `POST /api/users/:user/sessions`. */
export const CreateSessionRequestSchema = z.object({
  name: z.string().trim().min(1, 'Session name is required').max(60, 'Use at most 60 characters'),
});
/** See {@link CreateSessionRequestSchema}. */
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/** Body of `POST …/repos`. The URL itself is checked by the server (allowed protocols). */
export const AddRepoRequestSchema = z.object({
  url: z.string().trim().min(1, 'Repository URL is required').max(500),
});
/** See {@link AddRepoRequestSchema}. */
export type AddRepoRequest = z.infer<typeof AddRepoRequestSchema>;

const PathSourceSchema = z.object({ type: z.literal('path'), path: absolutePath });
/**
 * A snapshot of a cloned repo. `branch` is usually a branch name; a tag or a full or
 * abbreviated commit SHA also works, which pins the snapshot to an exact commit.
 */
export const GitSourceSchema = z.object({
  type: z.literal('git'),
  repoId: z.string().min(1, 'Choose a repository'),
  branch: z.string().trim().min(1, 'Choose a branch'),
});
/** See {@link GitSourceSchema}. */
export type GitSource = z.infer<typeof GitSourceSchema>;

/** One side of a folder comparison: a local folder or a branch of a cloned repo. */
export const SourceSchema = z.discriminatedUnion('type', [PathSourceSchema, GitSourceSchema]);
/** See {@link SourceSchema}. */
export type Source = z.infer<typeof SourceSchema>;

/** A bare absolute path is accepted as shorthand for a path source. */
const SourceInputSchema = z.union([
  absolutePath.transform((path): Source => ({ type: 'path', path })),
  SourceSchema,
]);

/** Body of `POST /api/compare/directories`. Each side is a source or a bare absolute path. */
export const DirectoryCompareRequestSchema = z.object({
  left: SourceInputSchema,
  right: SourceInputSchema,
  /** When given, the comparison is recorded in that session's recent list. */
  user: UsernameSchema.optional(),
  sessionId: SessionIdSchema.optional(),
});
/** What clients send (input type: bare paths allowed). See {@link DirectoryCompareRequestSchema}. */
export type DirectoryCompareRequest = z.input<typeof DirectoryCompareRequestSchema>;

/** Query of `GET /api/compare/files`: one or two absolute file paths. */
export const FileCompareQuerySchema = z
  .object({
    left: absolutePath.optional(),
    right: absolutePath.optional(),
  })
  .refine((q) => q.left !== undefined || q.right !== undefined, 'Provide at least one file path');
/** See {@link FileCompareQuerySchema}. */
export type FileCompareQuery = z.infer<typeof FileCompareQuerySchema>;

/**
 * A path inside a snapshot: POSIX, relative, no `.`/`..` segments. Git reads it literally
 * (never as pathspec magic).
 */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      p.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Invalid path in repository',
  );

/** A full commit id (SHA-1 or SHA-256). */
export const CommitIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Expected a full commit SHA');

const SessionFieldsSchema = z.object({ user: UsernameSchema, sessionId: SessionIdSchema });

/**
 * Body of `POST /api/snapshot/file-diff`: one file between two git snapshots. Give both paths
 * for a modified or renamed file, or one of them for a file that exists on one side only.
 */
export const SnapshotFileDiffRequestSchema = SessionFieldsSchema.extend({
  left: GitSourceSchema,
  right: GitSourceSchema,
  leftPath: RepoPathSchema.optional(),
  rightPath: RepoPathSchema.optional(),
  /** Show the whole file as context instead of 3 lines around each change. */
  fullFile: z.boolean().default(false),
  /**
   * Attribute each changed line with `git blame` (the default). `false` returns the same hunks
   * without commits, for showing the difference before anyone asks what accounts for it.
   */
  attribute: z.boolean().default(true),
}).refine(
  (r) => r.leftPath !== undefined || r.rightPath !== undefined,
  'Provide leftPath, rightPath or both',
);
/** What clients send. See {@link SnapshotFileDiffRequestSchema}. */
export type SnapshotFileDiffRequest = z.input<typeof SnapshotFileDiffRequestSchema>;

const UpstreamPairSchema = SessionFieldsSchema.extend({
  /** The snapshot whose history is examined (Base in the UI). */
  upstream: GitSourceSchema,
  /** The snapshot the commits are applied to (Target in the UI). */
  downstream: GitSourceSchema,
});

/** Body of `POST /api/upstream/commits`: which upstream commits to list. */
export const UpstreamCommitsRequestSchema = UpstreamPairSchema.extend({
  /** At most this many commits, newest first. */
  limit: z.number().int().min(1).max(200).default(20),
  /** Only commits committed on or after this day (`YYYY-MM-DD`, `git log --since`). */
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
  /** Follow only first parents (the mainline of merges). */
  firstParent: z.boolean().default(false),
  /** Leave out commits that downstream already contains (`upstream ^downstream`). */
  hideReachable: z.boolean().default(false),
  /**
   * Only commits that changed at least one of these paths in upstream (`git log -- paths`).
   * Literal paths, not pathspec patterns.
   */
  paths: z.array(RepoPathSchema).max(100).optional(),
});
/** What clients send. See {@link UpstreamCommitsRequestSchema}. */
export type UpstreamCommitsRequest = z.input<typeof UpstreamCommitsRequestSchema>;

/** Body of `POST /api/upstream/applicability`: apply one upstream commit to the downstream snapshot. */
export const ApplicabilityRequestSchema = UpstreamPairSchema.extend({ commit: CommitIdSchema });
/** What clients send. See {@link ApplicabilityRequestSchema}. */
export type ApplicabilityRequest = z.input<typeof ApplicabilityRequestSchema>;

/** Body of `POST /api/upstream/patch`: a commit's changes against its first parent. */
export const CommitPatchRequestSchema = SessionFieldsSchema.extend({
  upstream: GitSourceSchema,
  commit: CommitIdSchema,
});
/** What clients send. See {@link CommitPatchRequestSchema}. */
export type CommitPatchRequest = z.input<typeof CommitPatchRequestSchema>;
