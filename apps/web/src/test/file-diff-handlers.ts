import type {
  CommitInfo,
  DiffLine,
  DivergenceCommit,
  GitAncestry,
  GitBlame,
  GitDiff,
  SnapshotFileDiff,
} from '@om/shared';
import { HttpResponse, http, type HttpHandler } from 'msw';

/** What a test says a file's attributed diff is, asked for by path (missing on the side that has none). */
export type FileDiffFixture = (paths: {
  leftPath?: string;
  rightPath?: string;
}) => SnapshotFileDiff;

/**
 * MSW handlers for the git primitives a file diff is composed from (`diff`, `blame`, `ancestry`), answered
 * from one attributed fixture: the hunks without commits, each changed line's commit as `blame` says it,
 * and each commit's membership as `ancestry` says it. A test writes the diff it means once, as before.
 */
export function fileDiffHandlers(
  fixture: FileDiffFixture,
  options: { onBlame?: (path: string) => void } = {},
): HttpHandler[] {
  // Requests of several files can interleave, so each is answered from its own file (by path),
  // and membership comes from every commit any of them has named.
  const byPath = new Map<string, SnapshotFileDiff>();
  const known = new Map<
    string,
    { inLeft: boolean | null | undefined; inRight: boolean | null | undefined }
  >();
  return [
    http.post('*/api/git/diff', async ({ request }) => {
      const body = (await request.json()) as {
        files: Array<{ leftPath?: string; rightPath?: string }>;
      };
      const file = body.files[0] ?? {};
      const diff = fixture(file);
      for (const path of [diff.leftPath, diff.rightPath])
        if (path !== undefined) byPath.set(path, diff);
      for (const c of diff.commits) known.set(c.sha, { inLeft: c.inLeft, inRight: c.inRight });
      return HttpResponse.json<GitDiff>({
        files: [
          {
            ...diff,
            commits: [],
            hunks: diff.hunks.map((hunk) => ({
              ...hunk,
              lines: hunk.lines.map(withoutCommit),
            })),
          },
        ],
      });
    }),
    http.post('*/api/git/blame', async ({ request }) => {
      const body = (await request.json()) as {
        source: { branch: string };
        path: string;
        lines?: number[];
      };
      options.onBlame?.(body.path);
      const diff = byPath.get(body.path) ?? fixture({});
      const isLeft = body.source.branch === diff.leftCommit;
      const wanted = new Set(body.lines ?? []);
      const lines = diff.hunks.flatMap((hunk) =>
        hunk.lines.flatMap((line) => {
          const number = isLeft ? line.leftLine : line.rightLine;
          const side = isLeft ? 'removed' : 'added';
          if (line.kind !== side || line.commit === undefined || number === undefined) return [];
          if (!wanted.has(number)) return [];
          return [{ line: number, commit: line.commit, origLine: number, boundary: false }];
        }),
      );
      const shas = new Set(lines.map((l) => l.commit));
      const commits: CommitInfo[] = diff.commits.filter((c) => shas.has(c.sha)).map(infoOf);
      return HttpResponse.json<GitBlame>({
        path: body.path,
        commit: body.source.branch,
        lines,
        commits,
      });
    }),
    http.post('*/api/git/ancestry', async ({ request }) => {
      const body = (await request.json()) as { tip: { branch: string }; commits: string[] };
      const isLeft = body.tip.branch === leftTip(byPath);
      return HttpResponse.json<GitAncestry>({
        results: body.commits.map((commit) => {
          const membership = known.get(commit);
          const isAncestor = isLeft ? membership?.inLeft : membership?.inRight;
          return { commit, isAncestor: isAncestor ?? null };
        }),
      });
    }),
  ];
}

/** The Left commit of the file loads seen so far (every file of one comparison shares it). */
function leftTip(byPath: ReadonlyMap<string, SnapshotFileDiff>): string | undefined {
  return [...byPath.values()][0]?.leftCommit;
}

/** A changed line as git's diff gives it: no commit (blame says which commit it is). */
function withoutCommit(line: DiffLine): DiffLine {
  const rest = { ...line };
  delete rest.commit;
  return rest;
}

/** A commit's metadata, without the membership flags that only the fixture knows. */
function infoOf(commit: DivergenceCommit): CommitInfo {
  return {
    sha: commit.sha,
    subject: commit.subject,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authorDate: commit.authorDate,
    committerName: commit.committerName,
    committerEmail: commit.committerEmail,
    commitDate: commit.commitDate,
  };
}
