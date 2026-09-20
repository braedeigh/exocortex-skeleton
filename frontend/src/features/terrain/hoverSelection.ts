/**
 * hoverSelection.ts — what a gesture on the map MEANS, as two small rules
 * kept apart from the things that carry them out.
 *
 * Both rules used to live inside an event handler each — one in the canvas,
 * one in the page — where neither could be checked without a browser. They
 * are short but not obvious, and both have a failure that is invisible rather
 * than loud (a map that dims itself to announce nothing; a click that opens a
 * card she only meant to look past), so they live here with tests.
 *
 *   TWO-STAGE CLICK    a click on an agent or a table PICKS IT OUT; a click on
 *                      the already-picked-out one OPENS it. A double-click is
 *                      two clicks on the same body, so it does both in one
 *                      gesture — no timer to wait out, and nothing that
 *                      behaves differently under a finger than under a mouse.
 *   HOVER VS HOLD      a real hover outranks the pinned selection, a pinned
 *                      selection outranks nothing, and a body with nothing
 *                      wired to it never takes the highlight at all.
 *
 * Used by TerrainPage.tsx (the click) and terrainCanvas.ts (the highlight).
 *
 * Prompt that produced it: "clicking an agent highlights that agent and the
 * files it's touching rather than making a popup. i want a double click on
 * the agents to make a popup. same for the sql, i want them to highlight the
 * tables and files they're connected to on one click and a double click opens
 * it up".
 */

/** What a click on a body should do, given what's already picked out. */
export type TapStage = 'pick' | 'open';

/**
 * Decide the stage: `open` only when this body is the one already picked out.
 *
 * `heldId` is whatever the surface is holding — an agent's conversation id for
 * the orbs, a node id for the tables. Nothing picked out (null) is always a
 * `pick`, which is what makes the first click on a fresh map safe.
 */
export function tapStage(id: string, heldId: string | null): TapStage {
  return heldId !== null && heldId === id ? 'open' : 'pick';
}

/**
 * Which body the wiring highlight should point at.
 *
 * `hovered` is what the cursor is actually over, `held` what a click pinned,
 * and `isWired` says whether anything is joined to a given body. A real hover
 * wins over the pin, so sweeping the cursor across the map still answers about
 * whatever is under it; an unwired body is dropped at BOTH ends, because
 * lighting one would dim the whole map to say nothing.
 */
export function highlightTarget(
  hovered: string | null,
  held: string | null,
  isWired: (id: string) => boolean,
): string | null {
  if (hovered !== null && isWired(hovered)) return hovered;
  if (held !== null && isWired(held)) return held;
  return null;
}
