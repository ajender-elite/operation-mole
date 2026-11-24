import type {
  CommitInfo,
  CommitPatch,
  GitBlame,
  GitCherryPick,
  GitFile,
  GitGrep,
  GitGrepMatch,
  GitLog,
  GitLogCommit,
  GitRefEntry,
  GitRefs,
  GitTree,
  GitTreeNode,
} from '@om/shared';
import { HttpResponse, http, type HttpHandler } from 'msw';

/** A commit as the explorer shows it: its SHA, subject and author (date fixed, so output is stable). */
export const commitInfo = (sha: string, subject: string, authorName = 'Ada'): CommitInfo => ({
  sha,
  subject,
  authorName,
  authorEmail: `${authorName.toLowerCase()}@example.com`,
  authorDate: '2026-01-02T10:00:00Z',
  committerName: authorName,
  committerEmail: `${authorName.toLowerCase()}@example.com`,
  commitDate: '2026-01-02T10:00:00Z',
});

/** Answers `POST /api/git/tree` from a listing per folder ('' is the root); other folders are 404. */
export function treeHandler(
  listing: Record<string, GitTreeNode[]>,
  commit = 'c'.repeat(40),
): HttpHandler {
  return http.post('*/api/git/tree', async ({ request }) => {
    const body = (await request.json()) as { path?: string };
    const folder = body.path ?? '';
    const entries = listing[folder];
    if (entries === undefined) {
      return HttpResponse.json({ message: `${folder} does not exist` }, { status: 404 });
    }
    return HttpResponse.json<GitTree>({ commit, path: folder, entries });
  });
}

/** Answers `POST /api/git/file` from a map of path to file. */
export function fileHandler(files: Record<string, GitFile>): HttpHandler {
  return http.post('*/api/git/file', async ({ request }) => {
    const body = (await request.json()) as { path: string };
    const file = files[body.path];
    if (file === undefined) {
      return HttpResponse.json({ message: `${body.path} does not exist` }, { status: 404 });
    }
    return HttpResponse.json<GitFile>(file);
  });
}

/** Answers `POST /api/git/blame`, recording each request so a test can check whether blame was asked for. */
export function blameHandler(blames: Record<string, GitBlame>, asked: string[] = []): HttpHandler {
  return http.post('*/api/git/blame', async ({ request }) => {
    const body = (await request.json()) as { path: string };
    asked.push(body.path);
    const blame = blames[body.path];
    if (blame === undefined) {
      return HttpResponse.json({ message: 'Blame unavailable' }, { status: 400 });
    }
    return HttpResponse.json<GitBlame>(blame);
  });
}

/** Answers `POST /api/git/grep` with the matches it is given, recording each request. */
export function grepHandler(
  matches: GitGrepMatch[],
  requests: unknown[] = [],
  truncated = false,
): HttpHandler {
  return http.post('*/api/git/grep', async ({ request }) => {
    requests.push(await request.json());
    return HttpResponse.json<GitGrep>({ commit: 'c'.repeat(40), matches, truncated });
  });
}

/** Answers `POST /api/git/refs` with the given refs (and the compare-to commit, when asked). */
export function refsHandler(refs: GitRefEntry[]): HttpHandler {
  return http.post('*/api/git/refs', () => HttpResponse.json<GitRefs>({ refs }));
}

/** Answers `POST /api/git/log` with the given commits, recording each request. */
export function logHandler(
  commits: GitLogCommit[],
  requests: unknown[] = [],
  hasMore = false,
): HttpHandler {
  return http.post('*/api/git/log', async ({ request }) => {
    requests.push(await request.json());
    return HttpResponse.json<GitLog>({
      include: { commit: 'c'.repeat(40), ref: 'main', label: 'app @ main' },
      commits,
      hasMore,
      total: commits.length,
    });
  });
}

/**
 * Answers `POST /api/git/cherry-pick` per target: the result is looked up by `remote/branch`, and each
 * request is recorded.
 */
export function cherryPickHandler(
  results: Record<string, GitCherryPick>,
  requests: unknown[] = [],
): HttpHandler {
  return http.post('*/api/git/cherry-pick', async ({ request }) => {
    const body = (await request.json()) as {
      onto: { remote?: string; branch: string };
    };
    requests.push(body);
    const key = `${body.onto.remote ?? 'origin'}/${body.onto.branch}`;
    const result = results[key];
    if (result === undefined) {
      return HttpResponse.json({ message: `no result for ${key}` }, { status: 404 });
    }
    return HttpResponse.json<GitCherryPick>(result);
  });
}

/** A file entry for a tree listing. */
export const node = (
  name: string,
  kind: GitTreeNode['kind'] = 'file',
  folder = '',
): GitTreeNode => ({
  name,
  path: folder === '' ? name : `${folder}/${name}`,
  kind,
  oid: 'e'.repeat(40),
});

/** A text file's answer for `POST /api/git/file`. */
export const textFile = (path: string, text: string): GitFile => ({
  commit: 'c'.repeat(40),
  path,
  oid: 'e'.repeat(40),
  size: text.length,
  content: 'text',
  text,
});

/** A ref of a remote, pointing at `commit`. */
export const refEntry = (
  remote: string,
  name: string,
  overrides: Partial<GitRefEntry> = {},
): GitRefEntry => ({
  remote,
  kind: 'branch',
  name,
  commit: 'a'.repeat(40),
  commitDate: '2026-01-02T10:00:00Z',
  subject: `${name} tip`,
  ...overrides,
});

/** A log entry, for `logHandler`. */
export const logCommit = (sha: string, subject: string, authorName = 'Ada'): GitLogCommit => ({
  ...commitInfo(sha, subject, authorName),
  parents: ['9'.repeat(40)],
});

/** Answers `POST /api/git/files` with every path given (sorted, as the server sends them). */
export function filesHandler(paths: string[]): HttpHandler {
  return http.post('*/api/git/files', () =>
    HttpResponse.json({ commit: 'c'.repeat(40), paths: [...paths].sort(), truncated: false }),
  );
}

/** Answers `POST /api/git/show` for each commit SHA given, with its parents (and no file patches). */
export function showHandler(parentsOf: Record<string, string[]>): HttpHandler {
  return http.post('*/api/git/show', async ({ request }) => {
    const body = (await request.json()) as { source: { branch: string } };
    const sha = body.source.branch;
    const parents = parentsOf[sha];
    if (parents === undefined) {
      return HttpResponse.json({ message: 'Unknown commit' }, { status: 400 });
    }
    return HttpResponse.json<CommitPatch>({
      commit: sha,
      details: { ...commitInfo(sha, 'Change'), parents },
      files: [],
      truncated: false,
    });
  });
}
