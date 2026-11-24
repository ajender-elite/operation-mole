import type { CommitInfo } from '@om/shared';

/** What `git blame --porcelain` says: the commit for each final line, and each commit's metadata. */
export type BlameResult = {
  /** Final (snapshot) line number → commit SHA. */
  lines: Map<number, string>;
  commits: Map<string, CommitInfo>;
};

/** One line of a blamed file, as `git blame --porcelain` describes it. */
export type BlameLine = {
  /** Final (snapshot) line number, 1-based. */
  line: number;
  commit: string;
  /** Where the line was in that commit's version of the file. */
  origLine: number;
  /** The commit's path for the file, when git reports one (renames show up here). */
  origPath: string | undefined;
  /** The commit is a boundary of the blame (its history is outside the range asked for). */
  boundary: boolean;
};

const GROUP_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

/** `author-time` (Unix seconds) and `author-tz` (`+0530`) as ISO-8601 with that offset, like `%aI`. */
export function isoWithOffset(seconds: number, tz: string): string {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(tz);
  const sign = match?.[1] === '-' ? -1 : 1;
  const offsetMinutes = match ? sign * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const local = new Date((seconds + offsetMinutes * 60) * 1000).toISOString().slice(0, 19);
  const offset = match ? `${match[1]}${match[2]}:${match[3]}` : '+00:00';
  return `${local}${offset === '+00:00' || offset === '-00:00' ? 'Z' : offset}`;
}

const unbracket = (mail: string) => mail.replace(/^<(.*)>$/, '$1');

type Fields = Map<string, Map<string, string>>;

/** Walks porcelain output: every group header (line → commit), and each commit's first value per key. */
function readPorcelain(output: string): {
  groups: Array<{ line: number; commit: string; origLine: number }>;
  fields: Fields;
} {
  const groups: Array<{ line: number; commit: string; origLine: number }> = [];
  const fields: Fields = new Map();
  let sha: string | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith('\t')) continue; // the line's content
    const header = GROUP_HEADER.exec(line);
    if (header) {
      sha = header[1] ?? '';
      groups.push({ line: Number(header[3]), commit: sha, origLine: Number(header[2]) });
      if (!fields.has(sha)) fields.set(sha, new Map());
      continue;
    }
    if (sha === undefined) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    const commitFields = fields.get(sha);
    if (commitFields && !commitFields.has(key)) commitFields.set(key, value);
  }
  return { groups, fields };
}

/** Each commit's metadata, from its first set of porcelain fields. */
function commitsFrom(fields: Fields): Map<string, CommitInfo> {
  const commits = new Map<string, CommitInfo>();
  for (const [commit, f] of fields) {
    const get = (key: string) => f.get(key) ?? '';
    commits.set(commit, {
      sha: commit,
      subject: get('summary'),
      authorName: get('author'),
      authorEmail: unbracket(get('author-mail')),
      authorDate: isoWithOffset(Number(get('author-time')), get('author-tz')),
      committerName: get('committer'),
      committerEmail: unbracket(get('committer-mail')),
      commitDate: isoWithOffset(Number(get('committer-time')), get('committer-tz')),
    });
  }
  return commits;
}

/** Parses `git blame --porcelain` output (with any number of `-L` ranges). */
export function parseBlamePorcelain(output: string): BlameResult {
  const { groups, fields } = readPorcelain(output);
  const lines = new Map<number, string>();
  for (const group of groups) lines.set(group.line, group.commit);
  return { lines, commits: commitsFrom(fields) };
}

/**
 * Every blamed line of `git blame --porcelain` output, in file order, with its commit, its line
 * in that commit, the commit's path for the file, and whether the commit is a boundary.
 */
export function parseBlameLines(output: string): { lines: BlameLine[]; commits: CommitInfo[] } {
  const { groups, fields } = readPorcelain(output);
  const lines: BlameLine[] = groups
    .map((group) => {
      const commitFields = fields.get(group.commit);
      const origPath = commitFields?.get('filename');
      return {
        line: group.line,
        commit: group.commit,
        origLine: group.origLine,
        origPath,
        boundary: commitFields?.has('boundary') === true,
      };
    })
    .sort((a, b) => a.line - b.line);
  return { lines, commits: [...commitsFrom(fields).values()] };
}
