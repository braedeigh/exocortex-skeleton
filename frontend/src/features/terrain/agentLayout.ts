/**
 * agentLayout.ts — where the agent orbs and their names are allowed to sit.
 *
 * Four small pieces of geometry, kept out of the canvas so they can be tested
 * without a browser:
 *
 *   ROOM SIDE      an agent from the Coding room belongs on the left of the
 *                  map, one from the Personal room on the right. Where a new
 *                  orb first appears, and where a gentle sideways pull holds
 *                  it until its files pull harder.
 *   FENCE EXIT     an orb found inside the table section is moved to the
 *                  nearest edge of it. Orbs have no repo of their own, so they
 *                  can't leave "toward home" the way the file dots do — and an
 *                  agent that worked on both sides of the map is tethered to
 *                  the exact middle, which is where the shelves stand.
 *   PERSONAL SPACE two orbs closer than a set gap are pushed apart, so agents
 *                  that worked on the same files don't pile onto one spot.
 *   NAME PLACEMENT each orb's name tries above, below, right, then left of its
 *                  orb, and takes the first spot that doesn't cover a name
 *                  already placed or another orb — greedy label placement, the
 *                  way the table names already avoid each other. Screen space,
 *                  so it holds at every zoom without moving anything on the map.
 *
 * Used by terrainCanvas.ts (the orb seed and the 'x' force in setGraph, the
 * 'orbSpread' force, the tick handler, and the orb-name pass in draw()).
 *
 * Prompt that produced it: "Agents in terrain spawned in the coding room
 * should spawn on the left side of terrain. Agents spawning in personal should
 * be spawning over to the right" / "i need for the agent dots to be repulsed by the
 * sql tables … i want the names of the agents to be fully displayed when i
 * hover over them, and … less overlap between them" / "i want [the names to
 * move instead of the map], but i want the agents to push each other apart
 * more than they do now".
 */

/** An axis-aligned rectangle — a keep-out zone in world units, or a name's
 * box in screen pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Which side of the map an agent's room puts it on: the x to appear at and be
 * pulled toward, or null for "no side — leave it where the map puts it".
 *
 * Coding goes to the LEFTMOST repo's anchor and Personal to the RIGHTMOST.
 * The sides are read off the screen, not off repo names, so the rule holds
 * whatever the repos are called. Every other room (Orchestra, Research,
 * Linear, or none) has no side. A map with only one repo on it — a build's
 * map, or the main map with a repo switched off — has no left and right
 * ground to stand on, so nobody gets a side there either.
 */
export function laneSideX(lane: string, repoAnchorXs: readonly number[]): number | null {
  if (lane !== 'coding' && lane !== 'personal') return null;
  if (repoAnchorXs.length < 2) return null;
  const leftmost = Math.min(...repoAnchorXs);
  const rightmost = Math.max(...repoAnchorXs);
  if (leftmost === rightmost) return null;
  return lane === 'coding' ? leftmost : rightmost;
}

/**
 * Move a point inside the box to the nearest edge of it; null if it's already
 * outside (or exactly on the edge), meaning leave it be.
 *
 * Nearest edge rather than a fixed side: the orb goes out whichever way costs
 * it the least travel, so it settles on the fence close to where its tethers
 * were holding it instead of being thrown to the far side of the shelves.
 */
export function nearestExit(x: number, y: number, box: Box): { x: number; y: number } | null {
  if (x <= box.left || x >= box.right || y <= box.top || y >= box.bottom) return null;
  const toLeft = x - box.left;
  const toRight = box.right - x;
  const toTop = y - box.top;
  const toBottom = box.bottom - y;
  const least = Math.min(toLeft, toRight, toTop, toBottom);
  if (least === toTop) return { x, y: box.top };
  if (least === toBottom) return { x, y: box.bottom };
  if (least === toLeft) return { x: box.left, y };
  return { x: box.right, y };
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
