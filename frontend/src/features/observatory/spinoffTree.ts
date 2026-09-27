/**
 * spinoffTree.ts — fold the flat spinoff list into a family tree.
 *
 * The server (GET /api/spinoff/tree) sends every conversation that was spun
 * off or had something spun off from it, each naming its parent. This builds
 * the nesting SpinoffTreePage draws: roots first (a session with no parent,
 * or whose parent isn't in the list), newest family first, and each
 * session's children oldest first, so a family reads in the order it grew.
 */
import type { SpinoffTreeNode } from './api';

export interface SpinoffBranch {
  node: SpinoffTreeNode;
  children: SpinoffBranch[];
  /** The newest start anywhere in this branch — what orders the families. */
  latest: string;
}

export function buildSpinoffTree(nodes: readonly SpinoffTreeNode[]): SpinoffBranch[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, SpinoffTreeNode[]>();
  const roots: SpinoffTreeNode[] = [];
  for (const node of nodes) {
    if (node.parent && node.parent !== node.id && byId.has(node.parent)) {
      const siblings = childrenOf.get(node.parent) ?? [];
      siblings.push(node);
      childrenOf.set(node.parent, siblings);
    } else {
      roots.push(node);
    }
  }

  // Build one branch. `seen` guards against a parent loop in bad data, which
  // would otherwise recurse forever.
  const seen = new Set<string>();
  const grow = (node: SpinoffTreeNode): SpinoffBranch => {
    seen.add(node.id);
    const children = (childrenOf.get(node.id) ?? [])
      .filter((child) => !seen.has(child.id))
      .sort((a, b) => (a.started ?? '').localeCompare(b.started ?? ''))
      .map(grow);
    const latest = children.reduce(
      (newest, child) => (child.latest > newest ? child.latest : newest),
      node.started ?? '',
    );
    return { node, children, latest };
  };

  return roots.map(grow).sort((a, b) => b.latest.localeCompare(a.latest));
}

/** A spinoff's card title without the "spin: " the spawn door puts on it. */
export function treeTitle(node: SpinoffTreeNode): string {
  return node.title.replace(/^spin:\s*/, '') || node.id;
}
