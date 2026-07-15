/**
 * threadsTree.ts — pure logic for the /threads DAG view (threads-architecture.md
 * §3 multi-parent DAG, §7 derived layer). Kept free of React so the tree
 * flattening / "also under" / lens-filter rules are unit-testable without a
 * DOM. Consumes `ThreadsTreeResponse` (GET /api/threads/tree) and the flat
 * `Thread[]` roster (GET /api/threads).
 *
 * Render depth is capped at 2 (roots, then one level of children) per §3 —
 * a child's own children are never expanded inline, only noted (see
 * `grandchildNotes`). Deeper is reached by clicking through.
 */
import type { Thread, ThreadsTreeResponse } from '../journal/types';

/** A tree split by lifecycle: `visible` feeds the rendered DAG; `dormant`/
 * `retired` are pulled out into their own flat groups at the bottom instead
 * (threads-architecture.md §3 status lifecycle). `retired` is only non-empty
 * when the tree was fetched with `?include=retired` — the backend excludes
 * retired nodes by default. */
export interface StatusPartition {
  visible: string[];
  dormant: string[];
  retired: string[];
}

export function partitionByStatus(nodes: ThreadsTreeResponse['nodes']): StatusPartition {
  const visible: string[] = [];
  const dormant: string[] = [];
  const retired: string[] = [];
  for (const [slug, node] of Object.entries(nodes)) {
    if (node.status === 'dormant') dormant.push(slug);
    else if (node.status === 'retired') retired.push(slug);
    else visible.push(slug);
  }
  return { visible, dormant, retired };
}

/** The renderable DAG: top-level root cards, each with its depth-1 children
 * (already deduped/sorted by the backend's name order). A node with 2+
 * living parents appears under every parent that is itself a visible root —
 * "one file seen twice, not a copy" (§3). */
export interface VisibleTree {
  roots: string[];
  /** root slug -> its depth-1 children slugs, in display order. */
  childrenByRoot: Record<string, string[]>;
}

/**
 * Builds the render tree from the subset of nodes that aren't dormant/retired
 * (`visibleSlugs`, from `partitionByStatus`). A node whose every parent is
 * itself hidden (dormant/retired, or simply absent) is promoted to a root in
 * this view — so pulling a hub thread into the Dormant group doesn't orphan
 * its still-active children off the tree entirely.
 */
export function buildVisibleTree(tree: ThreadsTreeResponse, visibleSlugs: string[]): VisibleTree {
  const visibleSet = new Set(visibleSlugs);
  const isRoot = (slug: string) => {
    const parents = tree.nodes[slug]?.parents ?? [];
    return !parents.some((p) => visibleSet.has(p));
  };
  const roots = visibleSlugs.filter(isRoot);
  const rootSet = new Set(roots);
  // Preserve the backend's name-sorted root order; append any newly-promoted
  // roots (orphaned by a dormant/retired parent) after, also name-sorted.
  const orderedRoots = [
    ...tree.roots.filter((s) => rootSet.has(s)),
    ...roots
      .filter((s) => !tree.roots.includes(s))
      .sort((a, b) => (tree.nodes[a]?.name ?? a).localeCompare(tree.nodes[b]?.name ?? b)),
  ];
  const childrenByRoot: Record<string, string[]> = {};
  for (const root of orderedRoots) {
    childrenByRoot[root] = (tree.nodes[root]?.children ?? []).filter((c) => visibleSet.has(c));
  }
  return { roots: orderedRoots, childrenByRoot };
}

/** Names of the OTHER roots (besides `exceptRoot`) a depth-1 slug also
 * appears under — the "also under <names>" marker (§3). Empty when the
 * slug only has one parent among the visible roots. */
export function alsoUnder(visibleTree: VisibleTree, tree: ThreadsTreeResponse, slug: string, exceptRoot: string): string[] {
  return visibleTree.roots
    .filter((r) => r !== exceptRoot && (visibleTree.childrenByRoot[r] ?? []).includes(slug))
    .map((r) => tree.nodes[r]?.name ?? r);
}

/** One grandchild entry for a depth-1 node's "contains N more" note: named
 * always, and flagged `visible` when it's independently reachable as its own
 * card at depth ≤2 elsewhere (a root, or a depth-1 child under some other
 * root) — the caller renders a scroll-to/expand link keyed by `slug` in that
 * case, else just the name (deeper reached by clicking through, per §3). */
export interface GrandchildNote {
  slug: string;
  name: string;
  visible: boolean;
}

/** A depth-1 node's own children (§3: never expanded inline) — the raw tree
 * edges, not filtered to `visible`, since the note should still name a
 * dormant/retired grandchild rather than silently drop it; it just won't be
 * clickable (no card rendered for it in this view). */
export function grandchildNotes(tree: ThreadsTreeResponse, visibleTree: VisibleTree, slug: string): GrandchildNote[] {
  const rootSet = new Set(visibleTree.roots);
  const kids = tree.nodes[slug]?.children ?? [];
  return kids.map((k) => ({
    slug: k,
    name: tree.nodes[k]?.name ?? k,
    visible: rootSet.has(k) || visibleTree.roots.some((r) => (visibleTree.childrenByRoot[r] ?? []).includes(k)),
  }));
}

/** The front lens's flat list: every thread carrying `frontId`, sorted by
 * name — the lens invariant (a surface shows an item iff it carries that
 * front), no tree. */
export function filterByFront(threads: Thread[], frontId: string): Thread[] {
  return threads
    .filter((t) => (t.fronts ?? []).includes(frontId))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether the lens's front is this thread's PRIMARY front (first element) —
 * "owns" vs. "visiting" (§6 ownership rule, surfaced in the UI per spec). */
export function isPrimaryFront(thread: Thread, frontId: string): boolean {
  return (thread.fronts ?? [])[0] === frontId;
}

/** True if at least one thread in the roster carries at least one front —
 * gates whether the chips row renders at all (don't show an empty filter
 * row on the un-migrated vault, where every thread has fronts: []). */
export function anyThreadHasFronts(threads: Thread[]): boolean {
  return threads.some((t) => (t.fronts ?? []).length > 0);
}
