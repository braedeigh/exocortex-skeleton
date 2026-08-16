/**
 * layoutTree.ts — the shape of the workspace, as data.
 *
 * The desktop used to have exactly one shape: left box, divider, right box,
 * written straight into SplitLayout.tsx. This file replaces that hardcoded
 * shape with a little tree you can actually change at runtime — split a panel
 * in two, close one, drag the boundary — so a window can show one thing, two
 * things, or six.
 *
 * The tree has two kinds of node. A PANEL is a leaf: an actual thing you look
 * at. A SPLIT is a branch: several children laid out left-to-right ('row') or
 * top-to-bottom ('col'), each taking a percentage of the space. Splits nest,
 * which is how you get "left half is stacked in two, right half is one tall
 * panel" without the tree needing to know that arrangement in advance.
 *
 * Everything here is a PURE FUNCTION over that tree — no React, no storage, no
 * DOM. Every operation returns a NEW tree and returns the SAME object when
 * nothing changed, so React can skip re-rendering on a no-op. That's also what
 * makes the whole model testable without rendering anything (layoutTree.test.ts).
 *
 * New ids are passed IN rather than generated here, for the same reason: a
 * function that mints its own random ids can't be checked against an expected
 * result. panelStore.ts is the one that mints them.
 *
 * Touches: PanelTree.tsx (renders a tree), panelStore.ts (persists one and
 * mints ids), Workspace.tsx (owns the live one).
 *
 * Prompt that produced it: "being able to create multiple windows within the
 * browser... auto displays 2 in the split screen maybe, but I want to be able
 * to resize the panels and create multiple on one screen or just one".
 */

/**
 * What a panel is showing.
 *
 * - 'primary' — the app's normal routed content (the tab strip and whatever
 *   page the address bar says). Exactly one of these exists and it can't be
 *   closed: it's the panel the browser URL, the back button, and the tab bar
 *   all drive. Everything that worked before this file existed still works
 *   because this panel is unchanged.
 * - 'pane'    — the reading room stack: Observatory / the open session /
 *   Terminal, with its own switcher and its own back. This is the old left box.
 * - 'route'   — any other page in the app, running on its own private router
 *   so it can sit at a different URL than the primary panel. This is the kind
 *   that lets the terrain map and a code file be on screen at the same time.
 */
export type PanelKind = 'primary' | 'pane' | 'route';

export interface PanelNode {
  type: 'panel';
  id: string;
  kind: PanelKind;
  /** Where a 'route' panel is pointed, e.g. "/code?repo=skeleton&path=server.py".
   *  Unused by the other two kinds. */
  url?: string;
  /** Which set of pinned tabs this panel's bar wears (tabSets.ts). Per panel,
   *  and saved with the layout, because that's the point of having two: the
   *  monitor running sessions wants a different bar from the one running the
   *  journal. Absent = the first set. */
  setId?: string;
}

export interface SplitNode {
  type: 'split';
  id: string;
  /** 'row' = children side by side, 'col' = children stacked. */
  dir: 'row' | 'col';
  /** One percentage per child, same length as `children`, summing to 100. */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PanelNode | SplitNode;

/** No panel may be dragged below this share of its split. Small enough to get
 *  a panel out of the way, big enough that its header stays grabbable — a
 *  panel you can shrink to nothing is a panel you can lose. */
export const MIN_PCT = 8;

/* ---------- reading the tree ---------- */

export function listPanels(node: LayoutNode): PanelNode[] {
  if (node.type === 'panel') return [node];
  return node.children.flatMap(listPanels);
}

export function findPanel(node: LayoutNode, id: string): PanelNode | null {
  if (node.type === 'panel') return node.id === id ? node : null;
  for (const child of node.children) {
    const hit = findPanel(child, id);
    if (hit) return hit;
  }
  return null;
}

/** The split that directly contains this node, or null if it's the root. */
export function parentOf(root: LayoutNode, id: string): SplitNode | null {
  if (root.type === 'panel') return null;
  if (root.children.some((c) => c.id === id)) return root;
  for (const child of root.children) {
    const hit = parentOf(child, id);
    if (hit) return hit;
  }
  return null;
}

/* ---------- changing the tree ---------- */

/**
 * Put a new panel next to an existing one.
 *
 * The nicety here: if the target's parent is ALREADY splitting in the
 * direction you asked for, the new panel joins that split as a sibling instead
 * of nesting a fresh split inside it. Without this, splitting right three
 * times gives you a lopsided staircase of nested pairs; with it you get three
 * even columns, which is what anyone actually means by "split it again".
 *
 * The new panel takes half of the target's space, so the rest of the layout
 * doesn't move.
 */
export function splitPanel(
  root: LayoutNode,
  targetId: string,
  dir: 'row' | 'col',
  newPanel: PanelNode,
  newSplitId: string,
): LayoutNode {
  if (!findPanel(root, targetId)) return root;

  const parent = parentOf(root, targetId);
  if (parent && parent.dir === dir) {
    const i = parent.children.findIndex((c) => c.id === targetId);
    const half = parent.sizes[i] / 2;
    const sizes = [...parent.sizes];
    sizes[i] = half;
    sizes.splice(i + 1, 0, half);
    const children = [...parent.children];
    children.splice(i + 1, 0, newPanel);
    return replaceNode(root, parent.id, { ...parent, sizes, children });
  }

  // Otherwise the target becomes a two-child split of itself and the newcomer.
  return replaceNode(root, targetId, (target) => ({
    type: 'split',
    id: newSplitId,
    dir,
    sizes: [50, 50],
    children: [target, newPanel],
  }));
}

/**
 * Remove a panel. A split left holding a single child is pointless, so it
 * collapses into that child — which is what makes "close the second panel"
 * return you to a plain full-window view rather than a split-of-one.
 *
 * Removing the last panel is refused: the workspace has to be showing
 * something.
 */
export function closePanel(root: LayoutNode, id: string): LayoutNode {
  if (root.type === 'panel') return root; // the last panel standing
  const next = removeNode(root, id);
  return next ?? root;
}

function removeNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'panel') return node.id === id ? null : node;

  let changed = false;
  const kept: LayoutNode[] = [];
  const keptSizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = removeNode(child, id);
    if (next === null) {
      changed = true;
      return;
    }
    if (next !== child) changed = true;
    kept.push(next);
    keptSizes.push(node.sizes[i]);
  });

  if (!changed) return node;
  if (kept.length === 0) return null;
  // A split of one is just its child — hand the child up, and let it inherit
  // the space the whole split was using.
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept, sizes: normalizeSizes(keptSizes) };
}

/** Drag a boundary: move `delta` percent from the child after it to the child
 *  before it (or the other way for a negative delta). Only those two children
 *  move, so dragging one boundary never disturbs the rest of the row. */
export function resizeSplit(
  root: LayoutNode,
  splitId: string,
  boundary: number,
  delta: number,
): LayoutNode {
  const target = findSplit(root, splitId);
  if (!target) return root;
  const a = target.sizes[boundary];
  const b = target.sizes[boundary + 1];
  if (a === undefined || b === undefined) return root;

  // Clamp so neither side crosses MIN_PCT. Both panels keep a grabbable
  // header no matter how hard the boundary is thrown.
  const move = Math.max(Math.min(delta, b - MIN_PCT), -(a - MIN_PCT));
  if (move === 0) return root;

  const sizes = [...target.sizes];
  sizes[boundary] = a + move;
  sizes[boundary + 1] = b - move;
  return replaceNode(root, splitId, { ...target, sizes });
}

/** Point a 'route' panel at a different page. */
export function setPanelUrl(root: LayoutNode, id: string, url: string): LayoutNode {
  const panel = findPanel(root, id);
  if (!panel || panel.url === url) return root;
  return replaceNode(root, id, { ...panel, url });
}

/** Swap which set of pinned tabs this panel's bar wears. */
export function setPanelSet(root: LayoutNode, id: string, setId: string): LayoutNode {
  const panel = findPanel(root, id);
  if (!panel || panel.setId === setId) return root;
  return replaceNode(root, id, { ...panel, setId });
}

/* ---------- helpers ---------- */

function findSplit(node: LayoutNode, id: string): SplitNode | null {
  if (node.type === 'panel') return null;
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findSplit(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Swap one node for another (or for whatever a function makes of it),
 *  rebuilding only the branch that leads to it. */
function replaceNode(
  node: LayoutNode,
  id: string,
  next: LayoutNode | ((current: LayoutNode) => LayoutNode),
): LayoutNode {
  if (node.id === id) return typeof next === 'function' ? next(node) : next;
  if (node.type === 'panel') return node;
  let changed = false;
  const children = node.children.map((child) => {
    const c = replaceNode(child, id, next);
    if (c !== child) changed = true;
    return c;
  });
  return changed ? { ...node, children } : node;
}

/** Rescale a set of sizes back to summing 100 — used after a removal leaves a
 *  split's percentages short. */
export function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 100 / sizes.length);
  return sizes.map((s) => (s / total) * 100);
}

/**
 * Is this thing actually a layout tree? Used on the way out of storage, where
 * the value could be anything — an older format, a half-written string, a key
 * something else scribbled on. A layout that fails this is dropped for the
 * default rather than crashing the whole app at boot: a broken workspace
 * should cost you your arrangement, not your session.
 */
export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false;
  const n = value as Record<string, unknown>;
  if (typeof n.id !== 'string') return false;
  if (n.type === 'panel') {
    return n.kind === 'primary' || n.kind === 'pane' || n.kind === 'route';
  }
  if (n.type === 'split') {
    if (n.dir !== 'row' && n.dir !== 'col') return false;
    if (!Array.isArray(n.children) || !Array.isArray(n.sizes)) return false;
    if (n.children.length < 2 || n.children.length !== n.sizes.length) return false;
    if (!n.sizes.every((s) => typeof s === 'number' && Number.isFinite(s))) return false;
    return n.children.every(isLayoutNode);
  }
  return false;
}
