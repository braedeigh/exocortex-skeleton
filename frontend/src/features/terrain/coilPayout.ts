/**
 * coilPayout.ts — the timing of a coil paying out: when each newly pulled dot
 * comes out of the tip, and how far along its short slide into place it is.
 *
 * Pure arithmetic on milliseconds, no canvas. terrainCanvas.ts asks it every
 * frame while a pull is running and moves the dots to match; tested in
 * coilPayout.test.ts.
 *
 * ONE AT A TIME, in quick succession. A pull brings out a step's worth of
 * older files at the coil's outer tip, and they come out in order — the next
 * one along the strand, then the next — so the coil visibly spirals outward
 * and pushes the curve at its tip ahead of it, instead of every new dot
 * flying out of the centre at once.
 *
 * THE GAP SHRINKS FOR A BIG PULL. A dot every PAYOUT_STEP_MS reads as one at a
 * time; but pulling the whole uploads archive brings out ~600, which at that
 * pace would take half a minute. So no pull is allowed longer than
 * PAYOUT_TOTAL_MS: past about fifty dots, the gap between them shrinks to fit.
 *
 * Prompt that produced it: "i'm wanting for the new files to pop up not quite
 * at the same time, but with like one at a time on the end of the spiral in
 * very quick succession so it has the effect of spiraling out, and it pushes
 * the curve until the end" — and, for a big pull, "shrink for big pulls so it
 * takes about 2 seconds".
 */

/** The gap between two dots coming out, for a small pull. */
export const PAYOUT_STEP_MS = 40;

/** The longest any pull takes to finish coming out, however big. */
export const PAYOUT_TOTAL_MS = 2000;

/** How long one dot takes to slide from the old tip into its own spot. */
export const PAYOUT_SLIDE_MS = 140;

/** How long the curve takes to straighten once there's nothing left to pull. */
export const STRAIGHTEN_MS = 450;

/** The gap between two dots coming out, for a pull of `count` of them. */
export function payoutStepMs(count: number): number {
  if (count <= 1) return PAYOUT_STEP_MS;
  return Math.min(PAYOUT_STEP_MS, PAYOUT_TOTAL_MS / count);
}

/**
 * How far one new dot is into its slide, `elapsedMs` after the pull began:
 * below 0 it hasn't come out yet, 1 is in place. `index` counts from the first
 * dot of this pull, so the first one starts the moment the pull does.
 *
 * Eased out — quick off the tip and settling into place — so a run of them
 * reads as being pushed out rather than marched.
 */
export function payoutProgress(elapsedMs: number, index: number, stepMs: number): number {
  const since = elapsedMs - index * stepMs;
  if (since < 0) return -1;
  const linear = Math.min(1, since / PAYOUT_SLIDE_MS);
  return 1 - (1 - linear) ** 3;
}

/** When the last dot of a `count`-dot pull is in place, in ms from the start. */
export function payoutDurationMs(count: number): number {
  if (count <= 0) return 0;
  return (count - 1) * payoutStepMs(count) + PAYOUT_SLIDE_MS;
}
