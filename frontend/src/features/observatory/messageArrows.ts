/**
 * messageArrows.ts — the shape of an arrow on a message line: where the line
 * starts and stops, and the three corners of each arrowhead.
 *
 * What this is, in plain English: a line between two agents says "these two
 * have messaged". An arrowhead on it says which way. A head sits at the end
 * of whoever RECEIVED messages, so a one-way line has one head and a
 * conversation has one at each end. This file is only the geometry, kept
 * apart from the drawing so it can be tested and so the two places that draw
 * message lines share it:
 *
 *   - SwarmNetwork.tsx — a swarm's drawing in the Observatory (SVG);
 *   - terrain/terrainCanvas.ts drawMessageThreads — the same lines between
 *     agent orbs on the Terrain map (canvas).
 *
 * It works in whatever units it is handed (drawing units, map units), so the
 * caller decides how big a head is on screen.
 *
 * Prompt that produced it: "I also want some arrow directionality of the
 * messages."
 */

export interface Point {
  x: number;
  y: number;
}

/** One message line, ready to draw. */
export interface MessageArrow {
  /** Where the stroked line runs. It stops at the base of a head, so a thick
   * line never pokes out past the head's point. */
  start: Point;
  end: Point;
  /** The corners of the head at each end; null where there is no head. */
  headAtStart: Point[] | null;
  headAtEnd: Point[] | null;
}

/** What one end of a line needs: where the agent is, how far from its centre
 * a head's point stops (its ring, plus a little air), and whether messages
 * arrived here. */
export interface ArrowEnd {
  at: Point;
  clear: number;
  headed: boolean;
}

/** An arrowhead: a triangle with its point at `tip`, facing along `direction`
 * (a unit vector). */
export function arrowHead(tip: Point, direction: Point, length: number, halfWidth: number): Point[] {
  const base = { x: tip.x - direction.x * length, y: tip.y - direction.y * length };
  return [
    tip,
    { x: base.x - direction.y * halfWidth, y: base.y + direction.x * halfWidth },
    { x: base.x + direction.y * halfWidth, y: base.y - direction.x * halfWidth },
  ];
}

/**
 * Lay out one message line between two agents.
 *
 * An end with a head: the head's point stops `clear` short of the agent's
 * centre, and the line stops at the head's base. An end without one: the
 * line stops `clear` short when `trimBare` is set (the map, where nothing
 * covers the line's end), or runs to the centre when it isn't (the swarm
 * drawing, where the ring is painted over it).
 *
 * Null when the two agents are too close for the heads to fit: an arrow with
 * no shaft says nothing.
 */
export function messageArrow(
  from: ArrowEnd,
  to: ArrowEnd,
  head: { length: number; halfWidth: number },
  trimBare = false,
): MessageArrow | null {
  const dx = to.at.x - from.at.x;
  const dy = to.at.y - from.at.y;
  const span = Math.hypot(dx, dy);
  const inset = (end: ArrowEnd) => (end.headed ? end.clear + head.length : trimBare ? end.clear : 0);
  if (span <= inset(from) + inset(to)) return null;
  const direction = { x: dx / span, y: dy / span };
  const back = { x: -direction.x, y: -direction.y };
  const along = (origin: Point, toward: Point, distance: number) => ({
    x: origin.x + toward.x * distance,
    y: origin.y + toward.y * distance,
  });
  return {
    start: along(from.at, direction, inset(from)),
    end: along(to.at, back, inset(to)),
    headAtStart: from.headed
      ? arrowHead(along(from.at, direction, from.clear), back, head.length, head.halfWidth)
      : null,
    headAtEnd: to.headed
      ? arrowHead(along(to.at, back, to.clear), direction, head.length, head.halfWidth)
      : null,
  };
}

/** How big a head is for a line this thick, in the same units as the width:
 * big enough to read on a thin line, growing gently with a thick one. */
export function headSize(lineWidth: number): { length: number; halfWidth: number } {
  return { length: 7 + lineWidth * 1.5, halfWidth: 3 + lineWidth * 0.9 };
}
