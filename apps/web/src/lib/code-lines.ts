import type { CommitInfo, GitBlame } from '@om/shared';

/** An inclusive range of 1-based line numbers. */
export type LineRange = { start: number; end: number };

/** `lines=10-20` (or `lines=12`) as a range; undefined when absent or not a range. */
export function parseLineRange(value: string | null): LineRange | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value ?? '');
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) return undefined;
  return { start, end };
}

/** The range as the URL writes it: `10-20`, or `12` for one line. */
export function formatLineRange(range: LineRange): string {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

/** One line of a file as the code view shows it, with who last changed it when blame is on. */
export type CodeRow = {
  number: number;
  text: string;
  /** The commit that last changed this line (blame), when known. */
  commit?: CommitInfo | undefined;
  /** The path the file had in that commit, when it was renamed since. */
  origPath?: string | undefined;
  /** True where a run of lines from the same commit starts: the blame tag is shown only there. */
  isRunStart: boolean;
};

/**
 * The rows of a file: its lines, each with the commit `blame` names for it. Blame lines are matched to
 * file lines by number; a line blame does not cover has no commit.
 */
export function codeRows(text: string, blame: GitBlame | undefined): CodeRow[] {
  const byCommit = new Map(blame?.commits.map((c) => [c.sha, c]) ?? []);
  const byLine = new Map(blame?.lines.map((l) => [l.line, l]) ?? []);
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  let previous: string | undefined;
  return lines.map((line, index) => {
    const number = index + 1;
    const blamed = byLine.get(number);
    const sha = blamed?.commit;
    const row: CodeRow = {
      number,
      text: line,
      commit: sha === undefined ? undefined : byCommit.get(sha),
      origPath: blamed?.origPath,
      // Only a line with a commit starts a run; a line blame does not cover shows no tag.
      isRunStart: sha !== undefined && sha !== previous,
    };
    previous = sha;
    return row;
  });
}
