import type { CompareNode } from '@om/shared';

/** A rename git detected between two snapshots. */
export type Rename = {
  from: string;
  to: string;
  /** Similarity in percent. */
  similarity: number;
};

/**
 * Marks renamed files in a comparison tree. The tree still pairs entries by path (an old
 * name is only in Base, a new one only in Target); a rename links those two entries
 * through `renamedTo`/`renamedFrom`. Renames whose entries aren't one-sided files are skipped.
 */
export function annotateRenames(root: CompareNode, renames: readonly Rename[]): void {
  const leaves = new Map<string, CompareNode>();
  const walk = (node: CompareNode) => {
    if (node.children === undefined) leaves.set(`${node.status}\0${node.path}`, node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  for (const { from, to, similarity } of renames) {
    const before = leaves.get(`only-left\0${from}`);
    const after = leaves.get(`only-right\0${to}`);
    if (!before || !after) continue;
    before.renamedTo = to;
    before.similarity = similarity;
    after.renamedFrom = from;
    after.similarity = similarity;
  }
}
