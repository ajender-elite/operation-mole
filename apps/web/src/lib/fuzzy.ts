/**
 * Fuzzy matching for go-to-file: the query's letters must appear in the path, in order. A letter that starts
 * a word (after `/`, `.`, `_`, `-` or at the start) or the file name, and letters that follow each other,
 * score higher; a shorter path scores higher. Case is ignored.
 */

const WORD_BREAK = /[/._-]/;

/**
 * How well `query` matches `path` (higher is better), or undefined when its letters do not all appear in
 * order.
 */
export function fuzzyScore(query: string, path: string): number | undefined {
  const needle = query.toLowerCase();
  const haystack = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const letter of needle) {
    const found = haystack.indexOf(letter, at);
    if (found < 0) return undefined;
    const isWordStart = found === 0 || WORD_BREAK.test(path.charAt(found - 1));
    score += 1;
    if (isWordStart) score += 3;
    if (found >= nameStart) score += 2;
    if (found === previous + 1) score += 4;
    previous = found;
    at = found + 1;
  }
  // Shorter paths first among equals, and a path that holds the whole query as one run beats scattered letters.
  if (haystack.includes(needle)) score += 6;
  return score - path.length / 1000;
}

/**
 * The paths that match `query`, best first, at most `limit`. An empty query keeps the paths as given (the
 * server's order), so the list is useful before anything is typed.
 */
export function rankPaths(paths: readonly string[], query: string, limit: number): string[] {
  if (query.trim() === '') return paths.slice(0, limit);
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const score = fuzzyScore(query.trim(), path);
    if (score !== undefined) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.path);
}
