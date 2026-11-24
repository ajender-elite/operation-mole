import type { DiffHunk, DiffLine } from '@om/shared';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Hunks parsed from a patch, and whether `maxLines` cut it short. */
export type ParsedHunks = {
  hunks: DiffHunk[];
  isTruncated: boolean;
};

/**
 * Parses the hunks of a single-file unified diff (git's `diff`/`show` output). Header lines
 * before the first `@@` are skipped; `\ No newline at end of file` markers are dropped.
 * Stops after `maxLines` hunk lines and reports the cut.
 */
export function parseHunks(patch: string, maxLines = Number.POSITIVE_INFINITY): ParsedHunks {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let left = 0;
  let right = 0;
  let count = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  for (const raw of lines) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      if (count >= maxLines) return { hunks, isTruncated: true };
      const leftStart = Number(header[1]);
      const rightStart = Number(header[3]);
      current = {
        header: raw,
        leftStart,
        leftCount: header[2] === undefined ? 1 : Number(header[2]),
        rightStart,
        rightCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      left = leftStart;
      right = rightStart;
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    const text = raw.slice(1);
    let line: DiffLine;
    if (marker === ' ') line = { kind: 'context', text, leftLine: left++, rightLine: right++ };
    else if (marker === '-') line = { kind: 'removed', text, leftLine: left++ };
    else if (marker === '+') line = { kind: 'added', text, rightLine: right++ };
    else continue; // "\ No newline at end of file", or the next file's header
    if (count >= maxLines) return { hunks, isTruncated: true };
    current.lines.push(line);
    count++;
  }
  return { hunks, isTruncated: false };
}

/**
 * One hunk covering a whole file that exists on one side only: every line is `removed`
 * (only in Left) or `added` (only in Right).
 */
export function wholeFileHunk(text: string, side: 'left' | 'right', maxLines: number): ParsedHunks {
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  const isTruncated = all.length > maxLines;
  const kept = all.slice(0, maxLines);
  if (all.length === 0) return { hunks: [], isTruncated: false };
  const lines: DiffLine[] = kept.map((lineText, i) =>
    side === 'left'
      ? { kind: 'removed', text: lineText, leftLine: i + 1 }
      : { kind: 'added', text: lineText, rightLine: i + 1 },
  );
  const n = all.length;
  return {
    hunks: [
      {
        header: side === 'left' ? `@@ -1,${n} +0,0 @@` : `@@ -0,0 +1,${n} @@`,
        leftStart: side === 'left' ? 1 : 0,
        leftCount: side === 'left' ? n : 0,
        rightStart: side === 'right' ? 1 : 0,
        rightCount: side === 'right' ? n : 0,
        lines,
      },
    ],
    isTruncated,
  };
}

/**
 * Splits a multi-file patch (`git diff-tree -p`) into one chunk per file, in git's order.
 * Each chunk starts with its `diff --git` line.
 */
export function splitFilePatches(patch: string): string[] {
  const chunks: string[] = [];
  let start = -1;
  let index = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      if (start >= 0) chunks.push(patch.slice(start, index));
      start = index;
    }
    index += line.length + 1;
  }
  if (start >= 0) chunks.push(patch.slice(start));
  return chunks;
}

/** Collapses sorted 1-based line numbers into inclusive ranges, joining gaps up to `gap` lines. */
export function lineRanges(lines: readonly number[], gap = 0): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && line <= last[1] + 1 + gap) last[1] = Math.max(last[1], line);
    else ranges.push([line, line]);
  }
  return ranges;
}
