import type { CompareNode, CompareSummary } from '@om/shared';

/** Counts the entries of a comparison: files by status (folders are not counted), and errors. */
export function summarize(root: CompareNode): CompareSummary {
  const summary: CompareSummary = {
    identical: 0,
    modified: 0,
    onlyLeft: 0,
    onlyRight: 0,
    errors: 0,
  };
  const visit = (node: CompareNode) => {
    const sides = [node.left, node.right].filter((s) => s !== undefined);
    const isFolder = sides.length > 0 && sides.every((s) => s.kind === 'directory');
    if (node.status === 'error') summary.errors++;
    else if (!isFolder) {
      if (node.status === 'identical') summary.identical++;
      else if (node.status === 'modified') summary.modified++;
      else if (node.status === 'only-left') summary.onlyLeft++;
      else summary.onlyRight++;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return summary;
}
