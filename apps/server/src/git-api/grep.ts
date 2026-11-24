import type { GitGrepMatch } from '@om/shared';
import type { GitService } from '../git/git-service.ts';
import type { ResolvedSnapshot } from '../git/repo-manager.ts';

/** Matches kept per search; the rest are reported as `truncated`. */
export const MAX_GREP_MATCHES = 1000;

export type GrepOptions = {
  query: string;
  regex: boolean;
  ignoreCase: boolean;
  paths: readonly string[] | undefined;
  context: number;
};

/**
 * Lines of one commit that match (`git grep -n --column -I -z`). Text files only, read literally
 * (`-F`) or as extended regular expressions (`-E`, POSIX, not PCRE). Context lines come from the same
 * run, so each match carries its neighbours without a second read.
 */
export async function grepCommit(
  git: GitService,
  snapshot: ResolvedSnapshot,
  options: GrepOptions,
  opt: { signal?: AbortSignal },
): Promise<{ matches: GitGrepMatch[]; truncated: boolean }> {
  const args = [
    'grep',
    '-z',
    '-n',
    '--column',
    '-I',
    options.regex ? '-E' : '-F',
    ...(options.ignoreCase ? ['-i'] : []),
    ...(options.context > 0 ? ['-C', String(options.context)] : []),
    '-e',
    options.query,
    snapshot.commit,
    // After `--` the paths are literal (see --literal-pathspecs in GitService).
    '--',
    ...(options.paths ?? []),
  ];
  const { stdout } = await git.run(snapshot.repoDir, args, { okExitCodes: [0, 1], ...opt });

  // Records are one per line: `<commit>:<path>\0<line>\0<column>\0<text>` for a match, and without the
  // column for a context line. Text has no newline, so splitting on newlines is exact.
  const prefix = `${snapshot.commit}:`;
  const lines = new Map<string, Map<number, string>>();
  const found: Array<{ path: string; line: number; column: number; text: string }> = [];
  for (const record of stdout.split('\n')) {
    const fields = record.split('\0');
    const [head = '', lineText = '', third = '', fourth] = fields;
    if (!head.startsWith(prefix)) continue; // a group separator ("--") or an empty line
    const path = head.slice(prefix.length);
    const line = Number(lineText);
    const isMatch = fourth !== undefined;
    const text = isMatch ? fourth : third;
    const byLine = lines.get(path) ?? new Map<number, string>();
    lines.set(path, byLine);
    byLine.set(line, text);
    if (isMatch) found.push({ path, line, column: Number(third), text });
  }

  const context = options.context;
  const kept = found.slice(0, MAX_GREP_MATCHES);
  const matches = kept.map((hit): GitGrepMatch => {
    const byLine = lines.get(hit.path);
    const around = (from: number, to: number) => {
      const out: Array<{ line: number; text: string }> = [];
      for (let n = from; n <= to; n++) {
        const text = byLine?.get(n);
        if (text !== undefined) out.push({ line: n, text });
      }
      return out;
    };
    return {
      path: hit.path,
      line: hit.line,
      column: hit.column,
      text: hit.text,
      before: around(Math.max(1, hit.line - context), hit.line - 1),
      after: around(hit.line + 1, hit.line + context),
    };
  });
  return { matches, truncated: found.length > MAX_GREP_MATCHES };
}
