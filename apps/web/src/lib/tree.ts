import type { CompareNode, CompareStatus } from '@om/shared';

/** Which entries the tree shows. A status shows entries with that status (and folders containing them). */
export type TreeFilter = 'all' | 'differences' | CompareStatus;

/** One visible row of the comparison tree, as produced by {@link flattenTree}. */
export type TreeRow = {
  node: CompareNode;
  depth: number;
  isDirectory: boolean;
  expanded: boolean;
};

/** Whether a node is a folder (on at least one side): folders have `children`. */
export const isDirectory = (node: CompareNode): boolean => node.children !== undefined;

/** The node at a relative path, preferring the folder when a file and a folder share a name. */
export function findNode(root: CompareNode, path: string): CompareNode | undefined {
  if (path === '') return root;
  let node: CompareNode | undefined = root;
  for (const part of path.split('/')) {
    const matches: CompareNode[] = node.children?.filter((c) => c.name === part) ?? [];
    // A file and a folder may share a name (one per side); paths address the folder.
    node = matches.find(isDirectory) ?? matches[0];
    if (!node) return undefined;
  }
  return node;
}

/** The file (non-folder) entry at a relative path, even when a folder shares its name. */
export function findEntry(root: CompareNode, path: string): CompareNode | undefined {
  const slash = path.lastIndexOf('/');
  const parent = slash < 0 ? root : findNode(root, path.slice(0, slash));
  return parent?.children?.find((c) => c.path === path && !isDirectory(c));
}

/** Stable unique key for a row: a file and a folder can share a path. */
export function rowKey(node: CompareNode): string {
  return `${node.path}\u0000${isDirectory(node) ? 'dir' : 'entry'}`;
}

function matches(node: CompareNode, filter: TreeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'differences') return node.status !== 'identical';
  return node.status === filter;
}

/** True if the node or any descendant matches the filter. */
function visible(node: CompareNode, filter: TreeFilter): boolean {
  return matches(node, filter) || (node.children?.some((c) => visible(c, filter)) ?? false);
}

/** Flattens the children of `dir` into display rows, descending into expanded directories. */
export function flattenTree(
  dir: CompareNode,
  expanded: ReadonlySet<string>,
  filter: TreeFilter,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: CompareNode, depth: number) => {
    for (const child of node.children ?? []) {
      if (!visible(child, filter)) continue;
      const isChildDirectory = isDirectory(child);
      const isExpanded = isChildDirectory && expanded.has(child.path);
      rows.push({ node: child, depth, isDirectory: isChildDirectory, expanded: isExpanded });
      if (isExpanded) walk(child, depth + 1);
    }
  };
  walk(dir, 0);
  return rows;
}

/** One breadcrumb: a folder name and its relative path ('' for the root). */
export type Crumb = {
  name: string;
  path: string;
};

/** Breadcrumbs from the root down to `path`; the first one is the root. */
export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ name: '', path: '' }];
  if (path === '') return crumbs;
  const parts = path.split('/');
  for (const [i, name] of parts.entries())
    crumbs.push({ name, path: parts.slice(0, i + 1).join('/') });
  return crumbs;
}

/** Paths of every folder under `node`, for "Expand all". */
export function collectDirectoryPaths(node: CompareNode): string[] {
  const paths: string[] = [];
  const walk = (n: CompareNode) => {
    for (const child of n.children ?? []) {
      if (isDirectory(child)) {
        paths.push(child.path);
        walk(child);
      }
    }
  };
  walk(node);
  return paths;
}

/**
 * Joins an absolute root and a POSIX relative path (as the server reports them).
 * The result uses the root's separator, so Windows roots like `C:\a` stay backslashed.
 */
export function joinPath(root: string, rel: string): string {
  if (rel === '') return root;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
}
