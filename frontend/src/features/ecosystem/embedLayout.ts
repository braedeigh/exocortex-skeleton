/**
 * embedLayout.ts — when is the food-map exhibit (/food-map?embed=1) in a
 * SMALL frame, and how much room does the map fit leave for the overlays?
 *
 * The exhibit sits in an <iframe> on the portfolio page, so the frame's own
 * window size is the card's size. In a big frame it wears a full caption and
 * the colour key; in a small one (a card on a phone, or the ~670×420 card on
 * a laptop) those would cover the map, so it drops to a one-line title and
 * the door. EcosystemPage.module.css applies the same cut with media queries
 * — the numbers there must match COMPACT_MAX_WIDTH / COMPACT_MAX_HEIGHT.
 * EcoMap reads fitPadding so the "everything in view" fit clears whatever
 * overlay set is showing.
 *
 * Prompt that produced it: the card on the portfolio page showed the caption
 * and chips covering the whole map at card size — "the ecosystem map doesn't
 * show on mudscryer.org yet".
 */

export const COMPACT_MAX_WIDTH = 720;
export const COMPACT_MAX_HEIGHT = 480;

/** Small frame: at or under either threshold. */
export function isCompactFrame(width: number, height: number): boolean {
  return width <= COMPACT_MAX_WIDTH || height <= COMPACT_MAX_HEIGHT;
}

export interface FitPadding {
  paddingTopLeft: [number, number];
  paddingBottomRight: [number, number];
}

/** Room the fit leaves around the sources so no overlay covers one. The
 * figures are the overlays' rough sizes from the stylesheet, not measured
 * live: full caption ~150px tall; key + door band ~76px, ~180px on a
 * phone-width frame where the key wraps and the door sits under it; compact
 * title line ~60px; door alone ~64px. */
export function embedFitPadding(width: number, height: number): FitPadding {
  if (isCompactFrame(width, height)) {
    return { paddingTopLeft: [16, 64], paddingBottomRight: [16, 64] };
  }
  const narrow = width <= 520;
  return { paddingTopLeft: [24, 150], paddingBottomRight: [24, narrow ? 180 : 76] };
}
