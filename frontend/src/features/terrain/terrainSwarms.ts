/**
 * terrainSwarms.ts — which agents on the map belong to the same swarm, drawn
 * as a soft shape wrapped around their orbs with the swarm's name on top.
 *
 * A swarm is a group of sessions that have messaged each other (docs/swarms.md);
 * the Observatory's /api/swarms lists each one's members. This file turns that
 * list into the groups the map draws, and works out each group's outline: the
 * smallest convex shape that holds every member orb with some room around it.
 * The drawing happens in terrainCanvas.ts (drawSwarmHulls / drawSwarmNames);
 * TerrainPage.tsx fetches the swarms and hands the groups over.
 *
 * Prompt that produced it: "swarms on the Terrain map: a soft hull + name
 * around member orbs, fed by /api/swarms."
 */

export interface SwarmGroup {
  id: number;
  name: string;
  /** Conversation ids of the swarm's members. */
  memberIds: string[];
}

interface Point {
  x: number;
  y: number;
}

/** The groups to draw, from the /api/swarms payload. A swarm with no members
 * draws nothing. The helper isn't a member (it talks to everyone), so it
 * never sits inside a hull. */
export function swarmGroups(
  swarms: readonly { id: number; name: string; members: readonly { conv: string }[] }[],
): SwarmGroup[] {
  return swarms
    .filter((swarm) => swarm.members.length > 0)
    .map((swarm) => ({ id: swarm.id, name: swarm.name, memberIds: swarm.members.map((m) => m.conv) }));
}

/** How many points stand in for each orb's rim. Enough that the outline's
 * ends look round rather than cut off; few enough to redo every frame. */
const RIM_POINTS = 16;

/**
 * The outline around a set of orbs: a convex polygon, corners in order.
 *
 * Each orb is stood in for by points on a circle `padding` wider than it, and
 * the outline is the convex hull of all of them (Andrew's monotone chain). The
 * rim points are what make the shape soft: around one orb it is a circle, and
 * around a row of them a rounded capsule. Empty when there are no orbs.
 */
export function swarmHull(
  orbs: readonly { x: number; y: number; radius: number }[],
  padding: number,
): Point[] {
  const points: Point[] = [];
  for (const orb of orbs) {
    const reach = orb.radius + padding;
    for (let i = 0; i < RIM_POINTS; i++) {
      const angle = (i / RIM_POINTS) * Math.PI * 2;
      points.push({ x: orb.x + Math.cos(angle) * reach, y: orb.y + Math.sin(angle) * reach });
    }
  }
  if (points.length < 3) return points;

  // Andrew's monotone chain: sort left to right, then walk the lower edge and
  // the upper edge, dropping any point that would make the edge turn inward.
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of points) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  // Each chain ends where the other begins, so drop that shared last point.
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Where the swarm's name sits: centred over the outline, at its top edge.
 * Null for an empty outline. */
export function swarmNameAnchor(hull: readonly Point[]): Point | null {
  if (hull.length === 0) return null;
  let top = hull[0].y;
  let left = hull[0].x;
  let right = hull[0].x;
  for (const p of hull) {
    if (p.y < top) top = p.y;
    if (p.x < left) left = p.x;
    if (p.x > right) right = p.x;
  }
  return { x: (left + right) / 2, y: top };
}
