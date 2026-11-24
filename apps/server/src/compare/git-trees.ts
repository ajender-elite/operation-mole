import type { CompareNode, EntryInfo, FolderComparison } from '@om/shared';
import type { TreeLeaf } from '../git-api/trees.ts';
import { summarize } from './summary.ts';
import { sortNodes } from './sort.ts';

/** One entry of a tree, as the comparison walks it. A submodule is a folder with no children. */
type Node = {
  info: EntryInfo;
  /** Object id: a blob for a file or symlink, a commit for a submodule, empty for a folder. */
  oid: string;
  isSubmodule: boolean;
  children: Map<string, Node>;
};

export type TreeComparisonInput = {
  /** Every file of the Left tree, by path. */
  left: ReadonlyMap<string, TreeLeaf>;
  /** Every file of the Right tree, by path. */
  right: ReadonlyMap<string, TreeLeaf>;
  /** Where each symlink points, by object id. */
  linkTargets: ReadonlyMap<string, string>;
  leftLabel: string;
  rightLabel: string;
};

const folderInfo = (): EntryInfo => ({ kind: 'directory', size: 0, mtimeMs: 0 });
const isFolder = (node: Node): boolean => node.info.kind === 'directory';

/** A tree's files and folders, built from its leaves. Folders appear once; their contents follow. */
function buildTree(
  leaves: ReadonlyMap<string, TreeLeaf>,
  linkTargets: ReadonlyMap<string, string>,
): Map<string, Node> {
  const top = new Map<string, Node>();
  for (const [filePath, leaf] of leaves) {
    const parts = filePath.split('/');
    let level = top;
    let prefix = '';
    for (const [i, part] of parts.entries()) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      if (i === parts.length - 1) {
        level.set(part, leafNode(leaf, linkTargets));
        continue;
      }
      let folder = level.get(part);
      if (folder === undefined) {
        folder = { info: folderInfo(), oid: '', isSubmodule: false, children: new Map() };
        level.set(part, folder);
      }
      level = folder.children;
    }
  }
  return top;
}

function leafNode(leaf: TreeLeaf, linkTargets: ReadonlyMap<string, string>): Node {
  if (leaf.kind === 'submodule') {
    return { info: folderInfo(), oid: leaf.oid, isSubmodule: true, children: new Map() };
  }
  const info: EntryInfo =
    leaf.kind === 'symlink'
      ? {
          kind: 'symlink',
          size: leaf.size,
          mtimeMs: 0,
          linkTarget: linkTargets.get(leaf.oid) ?? '',
        }
      : { kind: 'file', size: leaf.size, mtimeMs: 0 };
  return { info, oid: leaf.oid, isSubmodule: false, children: new Map() };
}

/**
 * The rules of Folder Compare, on git trees: a folder
 * is identical only if everything in it is; a file and a folder with the same name are two one-sided
 * entries; folders come first, then files. Compares object ids, so no bytes are read.
 */
function compareChildren(
  rel: string,
  left: Map<string, Node> | undefined,
  right: Map<string, Node> | undefined,
): CompareNode[] {
  const names = [...new Set([...(left?.keys() ?? []), ...(right?.keys() ?? [])])];
  const nodes = names.flatMap((name): CompareNode[] => {
    const a = left?.get(name);
    const b = right?.get(name);
    const childRel = rel === '' ? name : `${rel}/${name}`;
    if (a !== undefined && b !== undefined && isFolder(a) !== isFolder(b)) {
      return [compareNode(name, childRel, a, undefined), compareNode(name, childRel, undefined, b)];
    }
    return [compareNode(name, childRel, a, b)];
  });
  return sortNodes(nodes);
}

function compareNode(
  name: string,
  rel: string,
  a: Node | undefined,
  b: Node | undefined,
): CompareNode {
  const node: CompareNode = { name, path: rel, status: 'identical' };
  if (a) node.left = a.info;
  if (b) node.right = b.info;
  const isAFolder = a !== undefined && isFolder(a);
  const isBFolder = b !== undefined && isFolder(b);
  if (isAFolder || isBFolder) {
    node.children = compareChildren(
      rel,
      isAFolder ? a.children : undefined,
      isBFolder ? b.children : undefined,
    );
  }
  if (!b) node.status = 'only-left';
  else if (!a) node.status = 'only-right';
  else if (isAFolder && isBFolder) {
    if (a.isSubmodule || b.isSubmodule) {
      node.status = a.oid === b.oid ? 'identical' : 'modified';
    } else {
      node.status = (node.children ?? []).every((c) => c.status === 'identical')
        ? 'identical'
        : 'modified';
    }
  } else {
    node.status = a.info.kind === b.info.kind && a.oid === b.oid ? 'identical' : 'modified';
  }
  return node;
}

/** Compares two git trees the way the folder compare compares two folders, without a checkout. */
export function compareTreeLeaves(input: TreeComparisonInput): FolderComparison {
  const rootOf = (leaves: ReadonlyMap<string, TreeLeaf>): Node => ({
    info: folderInfo(),
    oid: '',
    isSubmodule: false,
    children: buildTree(leaves, input.linkTargets),
  });
  const root = compareNode('', '', rootOf(input.left), rootOf(input.right));
  return {
    leftLabel: input.leftLabel,
    rightLabel: input.rightLabel,
    root,
    summary: summarize(root),
  };
}
