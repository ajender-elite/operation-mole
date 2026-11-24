import type { CommitInfo, GitLogCommit, GitLogFile } from '@om/shared';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';
import { COMMIT_FORMAT } from '../snapshot/commit-records.ts';
import { objectView } from '../snapshot/object-view.ts';

/** Starts each commit's record in `git log -z` output, so it can't be mistaken for a numstat line. */
const RECORD = '\x1e';
/** Unit separator between the fields of one commit's header (as in {@link COMMIT_FORMAT}). */
const FIELD = '\x1f';
const FIELDS_BEFORE_BODY = 9;

export type LogRead = {
  /** Commits reachable from `include` and not from `exclude`, newest first, one page. */
  commits: GitLogCommit[];
  /** Whether another page of commits exists after this one. */
  hasMore: boolean;
  /** How many commits the whole range has (all pages). */
  total: number;
  /** With an exclude: whether it is in the history of include (a range log ends at an ancestor). */
  excludeIsAncestor?: boolean | undefined;
};

export type LogReadOptions = {
  limit: number;
  skip: number;
  firstParent: boolean;
  since?: string | undefined;
  paths?: readonly string[] | undefined;
  withBody: boolean;
  withStats: boolean;
};

/**
 * `git log include ^exclude` as one page of commits. Parsed from `-z` output: each commit is a
 * record starting with {@link RECORD}, and its numstat lines (when asked for) follow it. A rename's
 * numstat line has an empty path and is followed by the old and new paths.
 */
export async function readLog(
  git: GitService,
  include: ResolvedSnapshot,
  exclude: ResolvedSnapshot | undefined,
  options: LogReadOptions,
  signal?: AbortSignal,
): Promise<LogRead> {
  const view = objectView(include.repoDir, exclude?.repoDir ?? include.repoDir);
  const env = view.env;
  const opt = { env, ...(signal ? { signal } : {}) };
  const range = [
    include.commit,
    ...(exclude === undefined ? [] : [`^${exclude.commit}`]),
    ...(options.firstParent ? ['--first-parent'] : []),
    ...(options.since === undefined ? [] : [`--since=${options.since}T00:00:00`]),
  ];
  // After `--` the paths are read literally (see --literal-pathspecs in GitService).
  const pathArgs = ['--', ...(options.paths ?? [])];
  const format = `%x1e${COMMIT_FORMAT}${options.withBody ? '%x1f%B' : ''}`;
  const args = [
    'log',
    '-z',
    `--format=${format}`,
    ...(options.withStats ? ['--numstat', '-M'] : []),
    `--max-count=${options.limit + 1}`,
    `--skip=${options.skip}`,
    ...range,
    ...pathArgs,
  ];
  const [{ stdout }, counted, ancestry] = await Promise.all([
    git.run(view.cwd, args, opt),
    git.run(view.cwd, ['rev-list', '--count', ...range, ...pathArgs], opt),
    exclude === undefined
      ? undefined
      : git.run(view.cwd, ['merge-base', '--is-ancestor', exclude.commit, include.commit], {
          ...opt,
          okExitCodes: [0, 1],
        }),
  ]);
  const parsed = parseLog(stdout, options.withBody, options.withStats);
  return {
    commits: parsed.slice(0, options.limit),
    hasMore: parsed.length > options.limit,
    total: Number.parseInt(counted.stdout.trim(), 10) || 0,
    ...(ancestry === undefined ? {} : { excludeIsAncestor: ancestry.exitCode === 0 }),
  };
}

/** Splits `git log -z` output into commits, each with its files when they were asked for. */
export function parseLog(output: string, withBody: boolean, withStats: boolean): GitLogCommit[] {
  const segments = output.split('\0');
  const commits: Array<{ commit: GitLogCommit; files: GitLogFile[] }> = [];
  let current: { commit: GitLogCommit; files: GitLogFile[] } | undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = (segments[i] ?? '').replace(/^\n/, '');
    if (segment === '') continue;
    if (segment.startsWith(RECORD)) {
      const commit = parseHeader(segment.slice(RECORD.length), withBody);
      if (commit === undefined) {
        current = undefined;
        continue;
      }
      current = { commit, files: [] };
      commits.push(current);
      continue;
    }
    const numstat = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(segment);
    if (!withStats || current === undefined || numstat === null) continue;
    const [, added = '0', removed = '0', path = ''] = numstat;
    const isBinary = added === '-' || removed === '-';
    const base = {
      additions: isBinary ? 0 : Number(added),
      deletions: isBinary ? 0 : Number(removed),
      binary: isBinary,
    };
    if (path === '') {
      // A rename: the old and new paths follow as their own segments.
      const oldPath = segments[i + 1] ?? '';
      const newPath = segments[i + 2] ?? '';
      i += 2;
      current.files.push({ path: newPath, oldPath, ...base });
    } else {
      current.files.push({ path, ...base });
    }
  }
  return commits.map(({ commit, files }) => (withStats ? { ...commit, files } : commit));
}

function parseHeader(record: string, withBody: boolean): GitLogCommit | undefined {
  const fields = record.split(FIELD);
  const [sha, parents, an, ae, ad, cn, ce, cd, subject] = fields;
  if (sha === undefined || cd === undefined) return undefined;
  const info: CommitInfo = {
    sha,
    subject: subject ?? '',
    authorName: an ?? '',
    authorEmail: ae ?? '',
    authorDate: ad ?? '',
    committerName: cn ?? '',
    committerEmail: ce ?? '',
    commitDate: cd,
  };
  const body = withBody
    ? fields.slice(FIELDS_BEFORE_BODY).join(FIELD).replace(/\n$/, '')
    : undefined;
  return {
    ...info,
    parents: (parents ?? '').split(' ').filter((p) => p !== ''),
    ...(body === undefined ? {} : { body }),
  };
}
