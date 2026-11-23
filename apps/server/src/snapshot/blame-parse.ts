import type { CommitInfo } from '@om/shared';

/** What `git blame --porcelain` says: the commit for each final line, and each commit's metadata. */
export type BlameResult = {
  /** Final (snapshot) line number → commit SHA. */
  lines: Map<number, string>;
  commits: Map<string, CommitInfo>;
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

/** Parses `git blame --porcelain` output (with any number of `-L` ranges). */
export function parseBlamePorcelain(output: string): BlameResult {
  const lines = new Map<number, string>();
  const commits = new Map<string, CommitInfo>();
  const fields = new Map<string, Map<string, string>>();
  let sha: string | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith('\t')) continue; // the line's content
    const header = GROUP_HEADER.exec(line);
    if (header) {
      sha = header[1] ?? '';
      lines.set(Number(header[3]), sha);
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
  return { lines, commits };
}
