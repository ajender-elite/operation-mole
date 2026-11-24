import type { DiffHunk, DiffLine } from '@om/shared';

/** A line and its index within its hunk (the index is what a focused line points at). */
export type IndexedLine = { line: DiffLine; index: number };

/** One row of the side-by-side view: what Left shows and what Right shows at the same height. */
export type AlignedRow = { left: IndexedLine | undefined; right: IndexedLine | undefined };

/**
 * Lines of one hunk laid out side by side. Context lines sit on both sides. A run of removed
 * lines and the run of added lines that replaces it are paired row by row; whichever run is
 * longer continues alone, with the other side empty.
 */
export function alignRows(hunk: DiffHunk): AlignedRow[] {
  const rows: AlignedRow[] = [];
  let removed: IndexedLine[] = [];
  let added: IndexedLine[] = [];
  const flush = () => {
    const height = Math.max(removed.length, added.length);
    for (let i = 0; i < height; i++) {
      rows.push({ left: removed[i], right: added[i] });
    }
    removed = [];
    added = [];
  };
  for (const [index, line] of hunk.lines.entries()) {
    if (line.kind === 'removed') removed.push({ line, index });
    else if (line.kind === 'added') added.push({ line, index });
    else {
      flush();
      rows.push({ left: { line, index }, right: { line, index } });
    }
  }
  flush();
  return rows;
}
