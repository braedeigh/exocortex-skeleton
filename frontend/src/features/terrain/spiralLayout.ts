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
 * Used by coilFolders.ts (which decides WHICH files, for WHICH folders) and
 * terrainCanvas.ts (which pins them). Tested in spiralLayout.test.ts.
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
