/**
 * ringBodies.ts — how much ground a file dot holds on the Terrain map.
 *
 * A file an agent has touched wears a ring (white = read, purple = written).
 * That ring used to be paint on the glass: the physics knew nothing about it,
 * so a neighbouring dot could sit right on top of it. Here the ring becomes
 * the dot's BODY — the circle nothing else may enter — and terrainCanvas.ts
 * uses the one number from this file twice: once to draw the ring, once to
 * tell d3-force how far to keep the neighbours. Two callers, one number, so
 * they can never drift apart.
 *
 * Everything here is in WORLD units (the map's own ground), never screen
 * pixels — physics happens on the ground, and the ground doesn't know where
 * the camera is. That means the ring gets thinner as you zoom out and fatter
 * as you zoom in, which is the price of it being a real feature of the
 * terrain rather than an overlay.
 *
 * Prompt that produced it: "for the dots that are actively being read or
 * otherwise modified, i want the outer ring to be the physics that separates
 * them" → "the only thing i care about is if the ring physics causes the dots
 * to move further apart from one another so the rings aren't overlapping".
 */
import type { FileTouchKind } from './terrainGraph';

/**
 * The moat a RINGED file holds, beyond its own radius. Bigger than the
 * ordinary gap so the clearing is visible as a clearing — a file being worked
 * on shoulders the map away from itself, which is the whole point.
 *
 * Set wide — the clearing is meant to be the first thing the eye catches, a
 * hole opening in the crowd where work is happening. Wide enough that it now
 * governs the layout rather than fitting inside it: two of the hottest
 * possible dots (radius 13) ringed at 14 want 54 world units between them,
 * against the folder rope's ordinary 34, so a folder whose files are being
 * worked on visibly swells and settles back afterward. That only holds
 * together because the rope stretches to whatever the two bodies actually
 * need (see the link distance in terrainCanvas.ts) — on a fixed rope this
 * would be the strain that once had the pond tile wandering the map, the
 * spring pulling in while the collider throws out.
 */
export const RING_GAP = 14;

/** Ordinary breathing room for everything not wearing a ring — the collider's
 * long-standing constant, now named. */
export const NODE_GAP = 4;

/**
 * The circle nothing else may enter, in world units: the dot plus its moat.
 * Drawn as the ring, reserved by the collider. Because d3's collide separates
 * two nodes to at least the sum of their bodies, two ringed dots end up
 * exactly touching at their rings and never overlapping.
 */
export function bodyRadius(radius: number, ringed: boolean): number {
  return radius + (ringed ? RING_GAP : NODE_GAP);
}

/**
 * Do two ring sets say the same thing? Identity won't do — the page rebuilds
 * this map from a fresh payload several times a second, so an identical set
 * arrives as a brand-new Map constantly. Waking the physics for each of those
 * would mean a map that never settles and never sleeps.
 */
export function sameRings(
  a: ReadonlyMap<string, FileTouchKind>,
  b: ReadonlyMap<string, FileTouchKind>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, kind] of a) {
    if (b.get(id) !== kind) return false;
  }
  return true;
}
