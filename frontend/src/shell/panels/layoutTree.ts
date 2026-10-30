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
 * - 'primary' — the app's normal routed content (whatever page the address
 *   bar says). Exactly one of these exists: it's the panel the browser URL
 *   and the back button ride on. It CAN be closed — another
 *   panel is promoted to take the job over first (closePanel below), so there
 *   is never none.
 * - 'route'   — any other page in the app, running on its own private router
 *   so it can sit at a different URL than the primary panel. This is the kind
 *   that lets the terrain map and a code file be on screen at the same time.
 */
export type PanelKind = 'primary' | 'route';

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
  /** What she has OPEN in this panel, in the order she arranged them, with
   *  when she last arrived at each (panelTabs.ts). Saved, so tabs and their
   *  order survive a reload; a tab stays until she closes it. */
  tabs?: { url: string; at: number }[];
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

/* ---------- automatic full screen ---------- */

/** What one window's automatic full screen is doing right now. */
export interface FullScreenPlan {
  /** The panel the Observatory page fills the window from, whether or not full
   * screen is on: it's the panel that carries the on/off button. */
  home: string | null;
  /** The panels to draw as nothing. They stay mounted; the tree doesn't change. */
  hidden: ReadonlySet<string>;
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();
const OBSERVATORY_PATH = '/observatory';

/**
 * Which panels step aside so the Observatory page has the window.
 *
 * The home is the first panel sitting exactly on /observatory that may be one
 * (`eligible`: the Journal's list and the desktop app may not). Everything else
 * hides, except the panels in `beside`, the ones brought forward next to the
 * map (a session she opened, a panel she split off). When no panel is on the
 * page, or she turned it `off`, nothing hides, so leaving the page shows the
 * arrangement as she left it and coming back resumes.
 *
 * This is display only: no tree is changed and nothing about it is saved in the
 * layout, so every saved arrangement keeps working untouched.
 *
 * Prompt that produced it: "i'm also wanting for the observatory page to be
 * full screen when i'm on it."
 */
export function fullScreenPlan(
  root: LayoutNode,
  options: {
    primaryHref: string;
    off: boolean;
    beside: readonly string[];
    eligible?: (panel: PanelNode) => boolean;
  },
): FullScreenPlan {
  const { primaryHref, off, beside, eligible } = options;
  const panels = listPanels(root);
  const onPage = (panel: PanelNode) => {
    const url = panel.kind === 'primary' ? primaryHref : (panel.url ?? '');
    return url.split('?')[0].replace(/\/$/, '') === OBSERVATORY_PATH;
  };
  const home = panels.find((panel) => onPage(panel) && (eligible?.(panel) ?? true));
  if (!home) return { home: null, hidden: NOTHING_HIDDEN };
  if (off) return { home: home.id, hidden: NOTHING_HIDDEN };
  const kept = new Set([home.id, ...beside]);
  return { home: home.id, hidden: new Set(panels.filter((p) => !kept.has(p.id)).map((p) => p.id)) };
}

/** Is this whole part of the tree hidden? A split is only when all of it is. */
export function isWhollyHidden(node: LayoutNode, hidden: ReadonlySet<string>): boolean {
  return listPanels(node).every((panel) => hidden.has(panel.id));
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
 *
 * CLOSING THE PRIMARY PROMOTES AN HEIR. The primary is the panel the browser's
 * address bar drives, and the tree must always hold exactly one
 * (panelStore.ts refuses a saved layout without). So before it goes, the heir
 * (heirOf) becomes the primary: same id, same tab set, same open tabs, and
 * its own `url` dropped, since the address bar says where a primary is.
 * Workspace.tsx points the address bar at the heir's page first.
 *
 * Prompt: "then i need to be able to close the right side of the split screen
 * ... maybe if i have more than 1 split screen open, i would be able to close
 * until there's only 1 open."
 */
export function closePanel(root: LayoutNode, id: string): LayoutNode {
  if (root.type === 'panel') return root; // the last panel standing
  const closing = findPanel(root, id);
  if (!closing) return root;
  let tree: LayoutNode = root;
  if (closing.kind === 'primary') {
    const heir = heirOf(root, id);
    if (!heir) return root;
    const { url: _url, ...rest } = heir;
    tree = replaceNode(root, heir.id, { ...rest, kind: 'primary', setId: heir.setId ?? ROUTE_DEFAULT_SET });
  }
  const next = removeNode(tree, id);
  return next ?? root;
}

/** The set a route panel without one wears (Workspace.tsx renderHeaderLeft).
 *  An heir keeps it explicitly, because a primary without one wears 'life'. */
const ROUTE_DEFAULT_SET = 'work';

/**
 * Who takes over when the primary panel `id` closes: the route panel nearest
 * it in its own split — the neighbour that grows into its space — else the
 * first route panel anywhere. Null when there's no route panel to promote.
 */
export function heirOf(root: LayoutNode, id: string): PanelNode | null {
  const parent = parentOf(root, id);
  if (parent) {
    const at = parent.children.findIndex((c) => c.id === id);
    // Siblings by distance, the one after it first (it's what a split of two
    // collapses into either way).
    const byDistance = parent.children
      .map((child, i) => ({ child, distance: Math.abs(i - at) + (i < at ? 0.5 : 0) }))
      .filter((c) => c.child.id !== id)
      .sort((a, b) => a.distance - b.distance);
    for (const { child } of byDistance) {
      const found = listPanels(child).find((p) => p.kind === 'route');
      if (found) return found;
    }
  }
  return listPanels(root).find((p) => p.kind === 'route' && p.id !== id) ?? null;
}

/** Can this panel be closed right now? Any panel while there's more than one,
 *  except a primary with nobody to hand the address bar to. */
export function canClosePanel(root: LayoutNode, id: string): boolean {
  if (root.type === 'panel') return false;
  const panel = findPanel(root, id);
  if (!panel) return false;
  return panel.kind !== 'primary' || heirOf(root, id) !== null;
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
 *  move, so dragging one boundary never disturbs the rest of the row. `next` is
 *  the child after it, which is further along than `boundary + 1` when hidden
 *  panels sit between the two (fullScreenPlan). */
export function resizeSplit(
  root: LayoutNode,
  splitId: string,
  boundary: number,
  delta: number,
  next: number = boundary + 1,
): LayoutNode {
  const target = findSplit(root, splitId);
  if (!target) return root;
  const a = target.sizes[boundary];
  const b = target.sizes[next];
  if (a === undefined || b === undefined) return root;

  // Clamp so neither side crosses MIN_PCT. Both panels keep a grabbable
  // header no matter how hard the boundary is thrown.
  const move = Math.max(Math.min(delta, b - MIN_PCT), -(a - MIN_PCT));
  if (move === 0) return root;

  const sizes = [...target.sizes];
  sizes[boundary] = a + move;
  sizes[next] = b - move;
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

/** Replace a panel's open tabs. The caller does the work (panelTabs.ts); this
 *  only puts the result back, and returns the same tree when it's unchanged so
 *  a poll that finds no news doesn't re-render the workspace. */
export function setPanelTabs(
  root: LayoutNode,
  id: string,
  tabs: { url: string; at: number }[],
): LayoutNode {
  const panel = findPanel(root, id);
  if (!panel || panel.tabs === tabs) return root;
  return replaceNode(root, id, { ...panel, tabs });
}

/**
 * Move an open tab from one panel's row to another's, at gap `index` of the
 * target's open tabs — a tab dragged across the split.
 *
 * It LEAVES the source: one conversation is never open in two panels' rows at
 * once, since that would be two mounted views of the same chat. If the target
 * already has it, it just stays where it is there. Same tree back when nothing
 * moves (unknown panel, same panel, a url the source doesn't have open).
 */
export function moveTabToPanel(
  root: LayoutNode,
  fromPanelId: string,
  toPanelId: string,
  url: string,
  index: number,
): LayoutNode {
  if (fromPanelId === toPanelId) return root;
  const from = findPanel(root, fromPanelId);
  const to = findPanel(root, toPanelId);
  if (!from || !to) return root;
  const fromTabs = from.tabs ?? [];
  const tab = fromTabs.find((t) => t.url === url);
  if (!tab) return root;
  const toTabs = to.tabs ?? [];
  let nextTo = toTabs;
  if (!toTabs.some((t) => t.url === url)) {
    nextTo = [...toTabs];
    nextTo.splice(Math.max(0, Math.min(index, toTabs.length)), 0, tab);
  }
  const moved = replaceNode(root, fromPanelId, { ...from, tabs: fromTabs.filter((t) => t.url !== url) });
  return nextTo === toTabs ? moved : replaceNode(moved, toPanelId, { ...to, tabs: nextTo });
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
 * Take the retired reading-room panel out of a stored layout, so a saved
 * arrangement that still holds one keeps everything else. Works on the raw
 * stored value, before it's known to be a tree: a split left with one child
 * becomes that child, and its siblings share out the freed space.
 *
 * Her call: "the reading room shouldn't exist at all and is archaic".
 */
export function dropReadingRoom(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  if (node.type !== 'split' || !Array.isArray(node.children) || !Array.isArray(node.sizes)) return value;
  const sizes = node.sizes as number[];
  const kept: { child: unknown; size: number }[] = [];
  (node.children as unknown[]).forEach((child, i) => {
    const isRoom = !!child && typeof child === 'object' && (child as { kind?: unknown }).kind === 'pane';
    if (!isRoom) kept.push({ child: dropReadingRoom(child), size: sizes[i] });
  });
  if (kept.length === 0) return value;
  if (kept.length === 1) return kept[0].child;
  if (kept.length === node.children.length && kept.every((k, i) => k.child === (node.children as unknown[])[i])) return value;
  return { ...node, children: kept.map((k) => k.child), sizes: normalizeSizes(kept.map((k) => k.size)) };
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
    return n.kind === 'primary' || n.kind === 'route';
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
