/**
 * layoutMemory.ts — where the Terrain map was, so re-opening the page doesn't
 * lay the world out all over again.
 *
 * The map is a force simulation: every mount used to start one from scratch and
 * settle a few thousand dots into a *new* arrangement, so walking off the tab
 * and back cost her the map she'd learned. This module is one page-lifetime
 * memory — a plain module-level object, deliberately NOT localStorage — holding
 * each node's last resting position, which of them she dragged into place by
 * hand, and where the camera was pointing. terrainCanvas.ts writes it as an
 * engine is torn down and reads it as the next engine builds its graph
 * (TerrainPage mounts the engine with `remember: true`; the ambient backdrop
 * doesn't, so a wallpaper map can never overwrite the real one).
 *
 * Page-lifetime is the whole contract: navigate away and back and the map is
 * exactly as she left it; reload the browser and it lays out fresh.
 *
 * Prompt that produced it: "i want for the map to not have to reload every time
 * i open the page ... i also want to be able to drag nodes around and for it to
 * save that position until i refresh the page."
 */

/** One node's resting place. `pinned` means SHE put it there by dragging — the
 * engine holds those still (d3's fx/fy) instead of letting the physics have
 * them back. */
export interface RememberedNode {
  x: number;
  y: number;
  pinned: boolean;
}

/** The d3-zoom transform, flattened — pan (x, y) and scale (k). */
export interface RememberedCamera {
  x: number;
  y: number;
  k: number;
}

export interface RememberedLayout {
  nodes: Map<string, RememberedNode>;
  camera: RememberedCamera | null;
}

let remembered: RememberedLayout | null = null;

/**
 * Write the map down. Called once, as the engine is destroyed — nodes that
 * never got a position (a body the sim hadn't placed yet) are skipped rather
 * than remembered at 0,0, which would drag them to the origin on the way back.
 */
export function rememberLayout(
  nodes: Iterable<{ id: string; x?: number; y?: number; pinned?: boolean }>,
  camera: RememberedCamera | null,
): void {
  const map = new Map<string, RememberedNode>();
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    map.set(n.id, { x: n.x as number, y: n.y as number, pinned: n.pinned === true });
  }
  remembered = { nodes: map, camera };
}

/** What the last engine left behind, or null on the first mount since a
 * browser reload. */
export function recallLayout(): RememberedLayout | null {
  return remembered;
}

/** Drop the memory entirely — the next mount lays out fresh. Used by tests;
 * the running app just reloads the page. */
export function forgetLayout(): void {
  remembered = null;
}

/** Forget only the hand-placed ones, leaving every resting position alone —
 * what "release" does, so the physics gets those nodes back without the map
 * jumping. */
export function forgetPins(): void {
  if (!remembered) return;
  for (const n of remembered.nodes.values()) n.pinned = false;
}
