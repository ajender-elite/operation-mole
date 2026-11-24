import { z } from 'zod';

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

/** The name a repo's remote goes by: a git ref component, so it is safe inside `refs/remotes/<name>/`. */
export const RemoteNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,39}$/,
    'Use 1 to 40 lowercase letters, digits, "-" or "_", starting with a letter or digit',
  );
/** The remote a repo is cloned from; a git source without a remote means this one. */
export const DEFAULT_REMOTE = 'origin';

/** Body of `POST …/repos/:repoId/remotes`: another place the same repo lives (a fork, a mirror). */
export const AddRemoteRequestSchema = z.object({
  name: RemoteNameSchema,
  url: z.string().trim().min(1, 'Repository URL is required').max(500),
});
/** See {@link AddRemoteRequestSchema}. */
export type AddRemoteRequest = z.infer<typeof AddRemoteRequestSchema>;

/**
 * A snapshot of a cloned repo. `branch` is usually a branch name; a tag or a full or
 * abbreviated commit SHA also works, which pins the snapshot to an exact commit.
 */
export const GitSourceSchema = z.object({
  type: z.literal('git'),
  repoId: z.string().min(1, 'Choose a repository'),
  /** The remote the branch is on (see {@link DEFAULT_REMOTE}). */
  remote: RemoteNameSchema.optional(),
  branch: z.string().trim().min(1, 'Choose a branch'),
});
/** See {@link GitSourceSchema}. */
export type GitSource = z.infer<typeof GitSourceSchema>;

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
 * Body of `POST /api/git/log`: the commits reachable from `source` and not from `exclude`
 * (`git log source ^exclude`), newest first. The caller decides whether `exclude` itself belongs
 * in the view (a range log shows it as the end of the range).
 */
export const GitLogRequestSchema = SessionFieldsSchema.extend({
  source: GitSourceSchema,
  exclude: GitSourceSchema.optional(),
  /** Only commits that changed at least one of these literal paths. */
  paths: z.array(RepoPathSchema).max(100).optional(),
  firstParent: z.boolean().default(false),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  skip: z.number().int().min(0).default(0),
  /** Include each commit's full message (`body`). */
  withBody: z.boolean().default(false),
  /** Include each commit's changed files with line counts, renames and binary marks. */
  withStats: z.boolean().default(false),
  /** Only commits whose message contains this text (fixed text, case-insensitive). */
  grep: z.string().min(1).max(200).optional(),
  /** Only commits whose author name or email contains this text (fixed text, case-insensitive). */
  author: z.string().min(1).max(200).optional(),
  /** Parents before children (`--topo-order`), instead of newest-committed first. */
  topoOrder: z.boolean().default(false),
  /** Follow one file through its renames (`--follow`); needs exactly one path. */
  follow: z.boolean().default(false),
});
/** What clients send. See {@link GitLogRequestSchema}. */
export type GitLogRequest = z.input<typeof GitLogRequestSchema>;

/** Body of `POST /api/git/show`: one commit's metadata and changes against its first parent. */
export const GitShowRequestSchema = SessionFieldsSchema.extend({ source: GitSourceSchema });
/** What clients send. See {@link GitShowRequestSchema}. */
export type GitShowRequest = z.input<typeof GitShowRequestSchema>;

/** Body of `POST /api/git/resolve`: the commits that each revision names. */
export const GitResolveRequestSchema = SessionFieldsSchema.extend({
  sources: z.array(GitSourceSchema).min(1).max(20),
});
export type GitResolveRequest = z.input<typeof GitResolveRequestSchema>;

/** Body of `POST /api/git/tree`: one folder of a commit's tree (the root when `path` is absent). */
export const GitTreeRequestSchema = SessionFieldsSchema.extend({
  source: GitSourceSchema,
  path: RepoPathSchema.optional(),
});
export type GitTreeRequest = z.input<typeof GitTreeRequestSchema>;

/** Body of `POST /api/git/merge-base`: the best common ancestor of two revisions. */
export const GitMergeBaseRequestSchema = SessionFieldsSchema.extend({
  a: GitSourceSchema,
  b: GitSourceSchema,
});
export type GitMergeBaseRequest = z.input<typeof GitMergeBaseRequestSchema>;

/** Body of `POST /api/git/ancestry`: whether each commit is in the history of `tip`. */
export const GitAncestryRequestSchema = SessionFieldsSchema.extend({
  tip: GitSourceSchema,
  commits: z.array(CommitIdSchema).min(1).max(200),
});
export type GitAncestryRequest = z.input<typeof GitAncestryRequestSchema>;

/** Body of `POST /api/git/blame`: who last changed each line of a file (all of them, or some). */
export const GitBlameRequestSchema = SessionFieldsSchema.extend({
  source: GitSourceSchema,
  path: RepoPathSchema,
  lines: z.array(z.number().int().positive()).min(1).max(10_000).optional(),
});
export type GitBlameRequest = z.input<typeof GitBlameRequestSchema>;

/** Body of `POST /api/git/diff`: the hunks between two revisions, for pairs of file paths. */
export const GitDiffRequestSchema = SessionFieldsSchema.extend({
  left: GitSourceSchema,
  right: GitSourceSchema,
  files: z
    .array(
      z
        .object({ leftPath: RepoPathSchema.optional(), rightPath: RepoPathSchema.optional() })
        .refine((f) => f.leftPath !== undefined || f.rightPath !== undefined, 'Give a path'),
    )
    .min(1)
    .max(50),
  /** Show the whole file as context instead of 3 lines around each change. */
  fullFile: z.boolean().default(false),
});
export type GitDiffRequest = z.input<typeof GitDiffRequestSchema>;

/**
 * Body of `POST /api/git/merge-tree`: merges `theirs` into `ours` in a scratch object store that is
 * removed afterwards. `base` defaults to their merge base.
 */
export const GitMergeTreeRequestSchema = SessionFieldsSchema.extend({
  ours: GitSourceSchema,
  theirs: GitSourceSchema,
  base: GitSourceSchema.optional(),
});
export type GitMergeTreeRequest = z.input<typeof GitMergeTreeRequestSchema>;

/**
 * Body of `POST /api/git/patch-equivalents`: the commits on each side of `left...right` (after `exclude`),
 * and which of them make the same change on the other side.
 */
export const GitPatchEquivalentsRequestSchema = SessionFieldsSchema.extend({
  left: GitSourceSchema,
  right: GitSourceSchema,
  exclude: GitSourceSchema.optional(),
  /** Include each commit's message (`body`), for matching trailers such as `(cherry picked from …)`. */
  withBody: z.boolean().default(false),
  /** At most this many commits per side, newest first. */
  limit: z.number().int().min(1).max(1000).default(500),
});
export type GitPatchEquivalentsRequest = z.input<typeof GitPatchEquivalentsRequestSchema>;

/** Body of `POST /api/git/compare-trees`: every file of two trees, with its status (optionally some paths). */
export const GitCompareTreesRequestSchema = SessionFieldsSchema.extend({
  left: GitSourceSchema,
  right: GitSourceSchema,
  paths: z.array(RepoPathSchema).max(1000).optional(),
});
export type GitCompareTreesRequest = z.input<typeof GitCompareTreesRequestSchema>;

/** Body of `POST /api/git/files`: every file path of one commit (for go-to-file). */
export const GitFilesRequestSchema = SessionFieldsSchema.extend({ source: GitSourceSchema });
export type GitFilesRequest = z.input<typeof GitFilesRequestSchema>;

/** Body of `POST /api/git/file`: one file's text at one commit, or that it is binary or too large. */
export const GitFileRequestSchema = SessionFieldsSchema.extend({
  source: GitSourceSchema,
  path: RepoPathSchema,
});
export type GitFileRequest = z.input<typeof GitFileRequestSchema>;

/**
 * Body of `POST /api/git/grep`: lines of one commit that match `query` (fixed text, or an extended
 * regular expression), with up to `context` lines around each.
 */
export const GitGrepRequestSchema = SessionFieldsSchema.extend({
  source: GitSourceSchema,
  query: z.string().min(1).max(200),
  regex: z.boolean().default(false),
  ignoreCase: z.boolean().default(false),
  paths: z.array(RepoPathSchema).max(100).optional(),
  context: z.number().int().min(0).max(3).default(0),
});
export type GitGrepRequest = z.input<typeof GitGrepRequestSchema>;

/**
 * Body of `POST /api/git/refs`: every branch and tag of every remote of a repo. With `compareTo`, each
 * branch also carries how far it is ahead of and behind that commit.
 */
export const GitRefsRequestSchema = SessionFieldsSchema.extend({
  repoId: z.string().min(1, 'Choose a repository'),
  compareTo: GitSourceSchema.optional(),
});
export type GitRefsRequest = z.input<typeof GitRefsRequestSchema>;

/** Body of `POST /api/git/contains`: every branch and tag (of any remote) whose history holds the commit. */
export const GitContainsRequestSchema = SessionFieldsSchema.extend({ source: GitSourceSchema });
export type GitContainsRequest = z.input<typeof GitContainsRequestSchema>;

/** Body of `POST /api/git/patch-ids`: the patch id of each commit (null for merges and empty commits). */
export const GitPatchIdsRequestSchema = SessionFieldsSchema.extend({
  source: GitSourceSchema,
  commits: z.array(CommitIdSchema).min(1).max(200),
});
export type GitPatchIdsRequest = z.input<typeof GitPatchIdsRequestSchema>;

/**
 * Body of `POST /api/git/cherry-pick`: would `git cherry-pick <commits…>` onto `onto` succeed, applied in
 * the order given, each on the result of the one before? Nothing is written to any ref or worktree.
 */
export const GitCherryPickRequestSchema = SessionFieldsSchema.extend({
  onto: GitSourceSchema,
  commits: z.array(CommitIdSchema).min(1, 'Choose at least one commit').max(100),
});
export type GitCherryPickRequest = z.input<typeof GitCherryPickRequestSchema>;
