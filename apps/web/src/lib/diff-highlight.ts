import type { DiffHunk } from '@om/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { highlightLines, type HighlightedToken } from './highlight.ts';

/**
 * The lines of a diff's hunks as one text, one line each, in hunk order. The grammar reads the lines together,
 * so a string or comment that starts on one line is coloured on the next too.
 */
export function diffText(hunks: readonly DiffHunk[]): string {
  return hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join('\n');
}

/**
 * The tokens of each line of each hunk: `tokens[hunk][line]` (empty for a line that had none). Undefined when
 * the file has no highlighting at all.
 */
export function tokensByLine(
  hunks: readonly DiffHunk[],
  lines: HighlightedToken[][] | undefined,
): HighlightedToken[][][] | undefined {
  if (lines === undefined) return undefined;
  let next = 0;
  return hunks.map((hunk) => hunk.lines.map(() => lines[next++] ?? []));
}

/**
 * The highlighted lines of a diff, keyed by its text, so a changed diff is highlighted again. Null for a file
 * the highlighter does not cover; the view then shows plain text.
 */
export function useDiffHighlight(
  hunks: readonly DiffHunk[],
  filePath: string,
): UseQueryResult<HighlightedToken[][][] | null> {
  const text = diffText(hunks);
  return useQuery({
    queryKey: ['diff-highlight', filePath, text] as const,
    queryFn: async () => {
      const lines = await highlightLines(text, filePath);
      return tokensByLine(hunks, lines) ?? null;
    },
    enabled: text !== '',
  });
}
