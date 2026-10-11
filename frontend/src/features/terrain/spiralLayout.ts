/**
 * spiralLayout.ts — where each dot sits in a coil, and how big the coil is.
 *
 * Pure geometry: no DOM, no physics, no canvas. Hand it a count, get back a
 * position per dot and the radius of the circle they all fit inside. The map
 * (terrainCanvas.ts) pins the dots to those spots and hands that radius to
 * the collider as the coil's body, so the rest of the terrain bumps around
 * the whole coil instead of being laced through it.
 *
 * THE SHAPE IS AN ARCHIMEDEAN SPIRAL — the one whose arms stay a constant
 * distance apart, as opposed to a logarithmic spiral, whose arms fly apart as
 * it grows. Constant spacing is the whole point here: every dot on a coil is
 * the same kind of thing (one upload, one chat, one day's page), so no dot
 * should get more room than another, and the gap between arms has to stay
 * readable at the 600th dot as much as the 6th.
 *
 * NEWEST AT THE CENTRE, oldest at the tip. Three things fall out of that and
 * they're the reason for it:
 *   - the heat gradient agrees with the geometry — a bright core cooling down
 *     the arms — so the coil reads correctly before you know what it is;
 *   - widening the window is purely ADDITIVE at the outer tip: dot 0 stays
 *     dot 0, so nothing she was already looking at moves;
 *   - the centre is the newest file AND the click target, which is the one
 *     place on the coil she has a reason to reach for.
 *
 * A NEW FILE, though, shifts every index by one and so turns the whole coil by
 * a single step. That's deliberate and it's small (one dot's worth of angle);
 * it reads as the chain paying out another link.
 *
 * HOW BIG IT GETS. Arc length along the spiral is about πR²/b, so laying n
 * dots at arc spacing s with arm spacing b gives R ≈ √(n·s·b/π) — radius
 * grows with the SQUARE ROOT of the count. That's the property that makes
 * "stays about the same size unless you interact with it" true rather than
 * hopeful. Measured on the uploads archive, 2026-09-22: a month of it (53
 * files) draws at radius ~86, and the whole folder (685) at ~297 — thirteen
 * times the content for three and a half times the radius.
 *
 * THE TIP CURVE. Past the last dot the strand carries on as a brighter curve
 * peeling away into a hole — the coil drawn as a thread being pulled out of
 * somewhere, and the thing she taps to pull more out (`tipCurve`). When there's
 * nothing left to pull it straightens.
 *
 * Used by coilFolders.ts (which decides WHICH files, for WHICH folders) and
 * terrainCanvas.ts (which pins them and draws the curve). Tested in
 * spiralLayout.test.ts.
 *
 * Prompt that produced it: "arrange them into a spiral that only shows the
 * last month or so of uploads and works with the same heat map as the other
 * dots, but you could click the center to load more, so it stays kind of the
 * same size unless you interact with it ... and it would snake out in a chain
 * and enlarge the spiral" — later generalised to any folder ("can you make
 * this into a modular file that I can apply to different folders").
 */

/** The hole at the middle of a coil, in WORLD units. Nothing is placed inside
 * it: it's the folder node's own seat and the target she taps to widen the
 * window, so it has to stay clear and stay big enough to hit. */
export const SPIRAL_INNER_RADIUS = 26;

/** How far apart two NEIGHBOURING dots sit along the strand, in world units.
 * This is arc length, not straight-line distance, so the spacing stays even
 * through the tight turns near the centre where the strand curves hardest. */
export const SPIRAL_DOT_GAP = 20;

/** How much radius the strand gains per full turn — the gap between one arm
 * and the next one out. Held equal to the dot gap so the coil reads as a
 * regular mesh rather than as rings or as spokes. */
export const SPIRAL_TURN_GAP = 20;

export interface SpiralSpot {
  /** Offset from the coil's centre, in world units. */
  x: number;
  y: number;
  /** Distance from the centre — what the canvas fades the tip by. */
  radius: number;
  /** Where along the strand this dot sits, in radians from the centre. */
  angle: number;
}

export interface SpiralArrangement {
  /** One spot per dot, innermost (newest) first. */
  spots: SpiralSpot[];
  /** The circle the whole coil fits inside — the collider's body. */
  outerRadius: number;
}

export interface SpiralOptions {
  innerRadius?: number;
  dotGap?: number;
  turnGap?: number;
}

/**
 * Lay `count` dots along the coil, innermost first.
 *
 * Walked by ARC LENGTH rather than by angle, which is what keeps the spacing
 * even: a fixed angle step would bunch the dots near the centre and strew
 * them at the rim, because the same angle covers more ground the further out
 * you are. So each step turns by `gap / radius` — the angle that covers one
 * gap's worth of arc at the radius we're currently at.
 */
export function spiralSpots(count: number, options: SpiralOptions = {}): SpiralArrangement {
  const innerRadius = options.innerRadius ?? SPIRAL_INNER_RADIUS;
  const dotGap = options.dotGap ?? SPIRAL_DOT_GAP;
  const turnGap = options.turnGap ?? SPIRAL_TURN_GAP;
  const spots: SpiralSpot[] = [];
  if (count <= 0) return { spots, outerRadius: innerRadius };

  // Start on the rim of the centre hole and wind outward. `angle` is measured
  // from there, and radius grows by turnGap every full turn — the Archimedean
  // rule, written so the hole is added rather than wound through.
  let angle = 0;
  for (let i = 0; i < count; i += 1) {
    const radius = innerRadius + (turnGap * angle) / (2 * Math.PI);
    spots.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      radius,
      angle,
    });
    // Step by arc length. Dividing by the radius we're AT (not the one we're
    // heading to) is a first-order step; over a gap this small against a hole
    // this big the error never reaches a pixel, and it can't divide by zero
    // because innerRadius is the floor.
    angle += dotGap / radius;
  }

  const last = spots[spots.length - 1];
  return { spots, outerRadius: last.radius };
}

/**
 * Which way the strand is heading at one of its spots — a unit vector along
 * the spiral, pointing outward along it (toward older dots).
 *
 * Worked out from the spiral's own rule rather than from the neighbouring dot,
 * so it's right at the very tip, where there's no dot past it to aim at. An
 * Archimedean spiral moves outward by turnGap/2π per radian while it goes
 * round by `radius` per radian; the direction is those two added together.
 */
export function spiralHeading(
  angle: number,
  radius: number,
  turnGap: number = SPIRAL_TURN_GAP,
): { x: number; y: number } {
  const outward = turnGap / (2 * Math.PI);
  const x = outward * Math.cos(angle) - radius * Math.sin(angle);
  const y = outward * Math.sin(angle) + radius * Math.cos(angle);
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

/** How long the tip's curve is, in world units — a couple of dots' worth, so
 * it reads as the strand carrying on rather than as a mark of its own. */
export const TIP_CURVE_LENGTH = 52;

/** How far the curve turns away from the coil over its length, in radians —
 * about seventy degrees, a thread peeling off its spool. */
export const TIP_CURVE_TURN = 1.2;

export interface TipCurveOptions {
  length?: number;
  turn?: number;
  /** 0 is the full peel; 1 is a straight line along the strand. */
  straightness?: number;
  /** How many points to draw it with. */
  samples?: number;
  turnGap?: number;
}

/**
 * The curve that leaves a coil's outer tip: the strand carrying on past its
 * last dot and peeling away from the coil into the hole it's pulled out of.
 *
 * It sets off in the direction the strand is already heading at the tip, so
 * the two join without a kink, and then bends OUTWARD — away from the coil,
 * never back into it: the outermost arm sits only one turn-gap inside the tip,
 * so a curve bending inward would cut straight across it. The bend is an arc
 * of one steady curvature, which is what a thread under a little tension does.
 *
 * `straightness` unbends it. At 1 it's a straight line along the strand —
 * what the curve turns into when there's nothing left to pull.
 *
 * Offsets from the coil's centre, like the spots. The first point is the tip
 * itself; the last is the mouth of the hole.
 */
export function tipCurve(
  tip: { x: number; y: number },
  angle: number,
  radius: number,
  options: TipCurveOptions = {},
): { x: number; y: number }[] {
  const length = options.length ?? TIP_CURVE_LENGTH;
  const turn = (options.turn ?? TIP_CURVE_TURN) * (1 - clampUnit(options.straightness ?? 0));
  const samples = Math.max(2, options.samples ?? 16);
  const heading = spiralHeading(angle, radius, options.turnGap);
  const startAt = Math.atan2(heading.y, heading.x);
  // Walk the arc in equal steps, turning a little each step. Turning by a
  // NEGATIVE angle is outward here: the spiral winds with its angle
  // increasing, so its heading runs a quarter-turn ahead of the direction
  // straight out from the centre, and turning back from it heads outward.
  const points = [{ x: tip.x, y: tip.y }];
  const step = length / (samples - 1);
  let x = tip.x;
  let y = tip.y;
  for (let i = 1; i < samples; i += 1) {
    // Heading at the middle of this step, so the arc comes out even
    // (the midpoint rule) instead of drifting to one side.
    const along = (i - 0.5) / (samples - 1);
    const facing = startAt - turn * along;
    x += Math.cos(facing) * step;
    y += Math.sin(facing) * step;
    points.push({ x, y });
  }
  return points;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
