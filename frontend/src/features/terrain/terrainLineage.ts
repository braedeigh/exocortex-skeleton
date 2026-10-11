/**
 * terrainLineage.ts — which agent was spun off from which, as arrows between orbs.
 *
 * Every spinoff session remembers its parent (`spawned_from` on the terrain
 * payload's sessions, written by routes/spinoff.py). This file turns that into
 * the pairs the map draws, and works out the shape of each arrow: a gentle
 * curve from the parent orb's rim to the child orb's rim, a chevron at its
 * middle and a head at the child end, so the direction reads even when only
 * part of the line is on screen. The drawing itself happens in
 * terrainCanvas.ts (drawLineage); TerrainPage.tsx hands the pairs over.
 * Why sessions carry a parent at all: docs/spinoff-lineage.md.
 *
 * Prompt that produced it: "connecting agents on terrain to each other too
 * with like a little arrow line, like with arrows on the line with a
 * directionality."
 */

export interface LineageLink {
  /** Conversation id of the session it was spun off from. */
  parentId: string;
  /** Conversation id of the spun-off session. */
  childId: string;
}

interface Point {
  x: number;
  y: number;
}

/** The arrow's shape, in the same world units the orbs are placed in. */
export interface LineageArrow {
  start: Point;
  control: Point;
  end: Point;
  /** Where the chevron sits (the curve's midpoint) and which way it faces. */
  middle: Point;
  middleDirection: Point;
  /** Which way the head at `end` faces. */
  endDirection: Point;
}

/** Pairs to draw, from the terrain payload's sessions. A session whose parent
 * is itself, or who names no parent, draws nothing. */
export function lineageLinks(
  sessions: readonly { id: string; spawned_from?: string | null }[],
): LineageLink[] {
  const links: LineageLink[] = [];
  for (const session of sessions) {
    const parent = session.spawned_from;
    if (parent && parent !== session.id) links.push({ parentId: parent, childId: session.id });
  }
  return links;
}

function unit(dx: number, dy: number): Point {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

/**
 * The curve from the parent orb to the child orb, trimmed so it starts and
 * ends at each orb's rim rather than its centre (a head buried inside the
 * child's ring can't be seen). Null when the orbs overlap — there's no room
 * for an arrow, and a line pointing into itself says nothing.
 *
 * This is a quadratic Bézier bowed to one side, the same bow the file
 * threads use, so two agents spun off from each other in turn don't draw on
 * top of one another.
 */
export function lineageArrow(
  parent: Point,
  parentRadius: number,
  child: Point,
  childRadius: number,
): LineageArrow | null {
  const dx = child.x - parent.x;
  const dy = child.y - parent.y;
  const length = Math.hypot(dx, dy);
  if (length <= parentRadius + childRadius) return null;

  // Bow perpendicular to the run, proportional to it but capped.
  const bow = Math.min(length * 0.14, 48);
  const control = {
    x: (parent.x + child.x) / 2 - (dy / length) * bow,
    y: (parent.y + child.y) / 2 + (dx / length) * bow,
  };

  // Trim each end back to its orb's rim. A quadratic curve leaves each end
  // heading straight at the control point, so stepping toward it by the
  // radius lands on the rim.
  const toControlFromParent = unit(control.x - parent.x, control.y - parent.y);
  const toControlFromChild = unit(control.x - child.x, control.y - child.y);
  const start = {
    x: parent.x + toControlFromParent.x * parentRadius,
    y: parent.y + toControlFromParent.y * parentRadius,
  };
  const end = {
    x: child.x + toControlFromChild.x * childRadius,
    y: child.y + toControlFromChild.y * childRadius,
  };

  // The midpoint of a quadratic curve and its heading there: at t = ½ the
  // point is ¼start + ½control + ¼end, and the tangent runs start → end.
  const middle = {
    x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
    y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
  };
  return {
    start,
    control,
    end,
    middle,
    middleDirection: unit(end.x - start.x, end.y - start.y),
    endDirection: unit(end.x - control.x, end.y - control.y),
  };
}
