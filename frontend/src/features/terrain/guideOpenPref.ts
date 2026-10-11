/**
 * guideOpenPref.ts — should the map's Guide panel be open when the page loads?
 *
 * The Guide (TerrainGuide.tsx) is the "?" beside the refresh chip: what the
 * shapes and colours on the map mean, and what a tap or a drag does. A
 * stranger arriving at the public site has none of that, so for them it opens
 * by itself the first time and stays out of the way after they close it once.
 * The owner knows her own map; for her it stays closed until she asks.
 *
 * The one fact remembered is "closed it once", in localStorage, so the rule
 * is a pure function of three booleans and the storage is kept at the edges.
 *
 * Touches: TerrainPage.tsx (reads the rule on mount, writes the dismissal on
 * close), shell/embed.ts (an embed has no chrome, so never a guide).
 *
 * Prompt that produced it: "i need a better key and like, a description of
 * how to interact with the map on the public site ... a question mark or
 * something ... that opens a split screen on the left or right".
 */

const STORAGE_KEY = 'terrain-guide-dismissed';

/** Open on load only for a visitor who has never closed it, and never inside
 * the embed card. */
export function shouldOpenGuideOnLoad(input: {
  visitor: boolean;
  embed: boolean;
  dismissed: boolean;
}): boolean {
  if (input.embed) return false;
  if (!input.visitor) return false;
  return !input.dismissed;
}

/** Read "closed it once" back. Missing storage (private mode, SSR) reads as
 * never dismissed, which errs on the side of showing the guide. */
export function readGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markGuideDismissed(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* storage refused — the guide will simply open again next visit */
  }
}
