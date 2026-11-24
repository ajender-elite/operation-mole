import type { PatchFile } from '@om/shared';

export const statusText: Record<PatchFile['status'], string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  other: 'Changed',
};

/** Files past this count start collapsed, so a large commit stays easy to scan. */
export const COLLAPSE_AFTER = 10;

/** A file's path as the commit names it: `old → new` for a rename. */
export function patchPath(file: PatchFile): string {
  return file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== file.newPath
    ? `${file.oldPath} → ${file.newPath}`
    : (file.newPath ?? file.oldPath ?? '');
}

/** Added and removed line counts of one file's hunks. */
export function countLines(file: PatchFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') additions += 1;
      else if (line.kind === 'removed') deletions += 1;
    }
  }
  return { additions, deletions };
}

/** The id of a file's section, so a summary can jump to it. */
export function fileAnchor(prefix: string, index: number): string {
  return `${prefix}-file-${index}`;
}
