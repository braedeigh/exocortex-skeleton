/**
 * agentLayout.ts — where the agent orbs and their names are allowed to sit.
 *
 * Four small pieces of geometry, kept out of the canvas so they can be tested
 * without a browser:
 *
 *   ROOM SIDE      an agent from the Coding room belongs on the left of the
 *                  map, one from the Personal room on the right.
 *   OUTSIDE SPOT   orbs stand OUTSIDE the cloud of files, a set gap clear of
 *                  it — anywhere on the ring round it. The cloud is measured
 *                  as one rectangle round every file, folder and table. An
 *                  orb found inside leaves by the nearest edge, counting its
 *                  own room's side as nearer than it is.
 *   PERSONAL SPACE two orbs closer than a set gap are pushed apart, so agents
 *                  that worked on the same files don't pile onto one spot.
 *   NAME PLACEMENT each orb's name tries above, below, right, then left of its
 *                  orb, and takes the first spot that doesn't cover a name
 *                  already placed or another orb — greedy label placement, the
 *                  way the table names already avoid each other. Screen space,
 *                  so it holds at every zoom without moving anything on the map.
 *
 * Used by terrainCanvas.ts (the 'orbSpread' force in setGraph, fenceOrbsOut
 * — run as each graph is built and after every physics step — and the
 * orb-name pass in draw()).
 *
 * Prompt that produced it: "Agents in terrain spawned in the coding room
 * should spawn on the left side of terrain. Agents spawning in personal should
 * be spawning over to the right" / "i need for the agent dots to be repulsed by the
 * sql tables … i want the names of the agents to be fully displayed when i
 * hover over them, and … less overlap between them" / "i want [the names to
 * move instead of the map], but i want the agents to push each other apart
 * more than they do now" / "i want for the agents to be spawning more outside
 * of the cloud of files than they are right now. right now they are all
 * jumbled up in the middle. i'm wanting them to spawn outside and then not be
 * so close to the rest of the files" / asked which side is outside: "ring all
 * around but with preference to sides".
 */

/** An axis-aligned rectangle — a keep-out zone in world units, or a name's
 * box in screen pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Which side of the cloud an orb's room leans it toward; null is "no side". */
export type OrbSide = 'left' | 'right' | null;

/**
 * Which side of the map an agent's room puts it on.
 *
 * Coding goes LEFT and Personal goes RIGHT — read off the screen, not off
 * repo names, so the rule holds whatever the repos are called. Every other
 * room (Orchestra, Research, Linear, or none) has no side. A map with only one
 * repo on it — a build's map, or the main map with a repo switched off — has
 * no left and right ground to stand on, so nobody gets a side there either.
 */
export function laneSide(lane: string, repoCount: number): OrbSide {
  if (repoCount < 2) return null;
  return lane === 'coding' ? 'left' : lane === 'personal' ? 'right' : null;
}

/**
 * Measure the cloud: the smallest rectangle holding every given body. Null
 * when there are none.
 *
 * A round body (a file dot, a folder) is given as a centre and a radius; a
 * rectangle that's already measured (a table, the shelves' keep-out zone) is
 * passed in `boxes` and simply joined on.
 */
export function boundsOf(
  bodies: Iterable<{ x?: number; y?: number; radius: number }>,
  boxes: readonly Box[] = [],
): Box | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const body of bodies) {
    const x = body.x ?? 0;
    const y = body.y ?? 0;
    left = Math.min(left, x - body.radius);
    right = Math.max(right, x + body.radius);
    top = Math.min(top, y - body.radius);
    bottom = Math.max(bottom, y + body.radius);
  }
  for (const box of boxes) {
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.bottom);
  }
  return left === Infinity ? null : { left, top, right, bottom };
}

/** How much nearer an orb's own side counts than it really is, when choosing
 * which edge to leave by: at 0.5, the side edge wins unless another edge is
 * less than half as far. */
const SIDE_EXIT_FAVOUR = 0.5;

/**
 * Where an orb has to stand to be outside the cloud, `gap` clear of it; null
 * if it's already there (or exactly on the line), meaning leave it be.
 *
 * Outside means out of the cloud's rectangle grown by `gap` — anywhere on the
 * ring round it. An orb found inside goes out through the nearest edge, so it
 * lands close to where its files are instead of being thrown across the map.
 * Its room's side is a preference, not a rule: the distance to that edge is
 * counted as shorter than it is (SIDE_EXIT_FAVOUR), so an orb starting deep
 * in the cloud comes out on its own side, while one that has only just
 * crossed the top edge is put back on the top edge.
 */
export function outsideSpot(
  x: number,
  y: number,
  side: OrbSide,
  cloud: Box,
  gap: number,
): { x: number; y: number } | null {
  const left = cloud.left - gap;
  const right = cloud.right + gap;
  const top = cloud.top - gap;
  const bottom = cloud.bottom + gap;
  if (x <= left || x >= right || y <= top || y >= bottom) return null;
  const toLeft = (x - left) * (side === 'left' ? SIDE_EXIT_FAVOUR : 1);
  const toRight = (right - x) * (side === 'right' ? SIDE_EXIT_FAVOUR : 1);
  const toTop = y - top;
  const toBottom = bottom - y;
  const least = Math.min(toLeft, toRight, toTop, toBottom);
  if (least === toLeft) return { x: left, y };
  if (least === toRight) return { x: right, y };
  if (least === toTop) return { x, y: top };
  return { x, y: bottom };
}

/** A body the personal-space rule can nudge — a d3 sim node's own fields. */
export interface Mover {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

/**
 * Push every pair of orbs closer than `gap` apart — a collision rule that
 * only orbs obey.
 *
 * Like d3's forceCollide it's NOT scaled by the sim's cooling: it corrects a
 * share (`strength`) of the overlap every tick, however cool the map is, so
 * the tethers pulling two agents onto the same files can't slowly win it back.
 * Each orb takes half the correction. Positions are read one step ahead
 * (x + vx), which is what keeps two orbs from overshooting through each other.
 * Two orbs on the exact same spot are split along a fixed diagonal so the rule
 * never divides by zero.
 */
export function spreadOrbs(orbs: readonly Mover[], gap: number, strength: number): void {
  for (let i = 0; i < orbs.length; i++) {
    const a = orbs[i];
    for (let j = i + 1; j < orbs.length; j++) {
      const b = orbs[j];
      let dx = (b.x ?? 0) + (b.vx ?? 0) - ((a.x ?? 0) + (a.vx ?? 0));
      let dy = (b.y ?? 0) + (b.vy ?? 0) - ((a.y ?? 0) + (a.vy ?? 0));
      let distance = Math.hypot(dx, dy);
      if (distance >= gap) continue;
      if (distance < 1e-6) {
        dx = 1;
        dy = 1;
        distance = Math.SQRT2;
      }
      const push = ((gap - distance) / distance) * strength * 0.5;
      a.vx = (a.vx ?? 0) - dx * push;
      a.vy = (a.vy ?? 0) - dy * push;
      b.vx = (b.vx ?? 0) + dx * push;
      b.vy = (b.vy ?? 0) + dy * push;
    }
  }
}

/** One orb asking for its name to be placed, all in screen pixels. */
export interface NameAsk {
  id: string;
  /** The orb's centre. */
  x: number;
  y: number;
  /** The orb's drawn radius. */
  radius: number;
  /** The name's measured width and line height. */
  width: number;
  height: number;
}

/** Where a name landed: its box, and which side of the orb it's on. */
export interface NamePlacement {
  box: Box;
  side: 'above' | 'below' | 'right' | 'left';
}

/** Clear space between an orb's edge and its name. */
const NAME_GAP = 8;

/** The four spots a name can take around its orb, in the order they're tried —
 * above first, because that's where every orb's name sat before this. */
function candidateBoxes(ask: NameAsk): NamePlacement[] {
  const { x, y, radius, width, height } = ask;
  const aboveBottom = y - radius - NAME_GAP;
  const belowTop = y + radius + NAME_GAP;
  return [
    { side: 'above', box: { left: x - width / 2, right: x + width / 2, top: aboveBottom - height, bottom: aboveBottom } },
    { side: 'below', box: { left: x - width / 2, right: x + width / 2, top: belowTop, bottom: belowTop + height } },
    { side: 'right', box: { left: x + radius + NAME_GAP, right: x + radius + NAME_GAP + width, top: y - height / 2, bottom: y + height / 2 } },
    { side: 'left', box: { left: x - radius - NAME_GAP - width, right: x - radius - NAME_GAP, top: y - height / 2, bottom: y + height / 2 } },
  ];
}

/** How many square pixels two boxes share. */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Place every orb's name, most important first — greedy label placement.
 *
 * `asks` arrive in priority order (the hovered orb first, so it always gets
 * its preferred spot). Each name takes the first of its four spots that covers
 * no name already placed and no OTHER orb; if every spot is covered, it takes
 * the one covering the least, so a name is never dropped — only moved.
 */
export function placeOrbNames(asks: readonly NameAsk[]): Map<string, NamePlacement> {
  const orbBoxes = asks.map((ask) => ({
    id: ask.id,
    box: { left: ask.x - ask.radius, right: ask.x + ask.radius, top: ask.y - ask.radius, bottom: ask.y + ask.radius },
  }));
  const placed = new Map<string, NamePlacement>();
  for (const ask of asks) {
    const blockers = [
      ...[...placed.values()].map((p) => p.box),
      ...orbBoxes.filter((orb) => orb.id !== ask.id).map((orb) => orb.box),
    ];
    let best: NamePlacement | null = null;
    let bestCovered = Infinity;
    for (const candidate of candidateBoxes(ask)) {
      const covered = blockers.reduce((sum, blocker) => sum + overlapArea(candidate.box, blocker), 0);
      if (covered < bestCovered) {
        best = candidate;
        bestCovered = covered;
      }
      if (covered === 0) break;
    }
    placed.set(ask.id, best!);
  }
  return placed;
}
