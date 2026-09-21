/**
 * hoverSelection.ts — what a gesture on the map MEANS, as three small rules
 * kept apart from the things that carry them out.
 *
 * They started out inside an event handler each — one in the canvas, one in
 * the page — where neither could be checked without a browser. They are short
 * but not obvious, and they fail invisibly rather than loudly (a selection
 * quietly handed over to whatever dot the cursor passed; a click that opens a
 * card she only meant to look past), so they live here with tests.
 *
 *   TWO-STAGE CLICK    a click on an agent or a table PICKS IT OUT; a click on
 *                      the already-picked-out one OPENS it. A double-click is
 *                      two clicks on the same body, so it does both in one
 *                      gesture — no timer to wait out, and nothing that
 *                      behaves differently under a finger than under a mouse.
 *   HOVER VS HOLD      a hover only counts INSIDE what's picked out: a pin is
 *                      the subject until she releases it, a spotlight lets a
 *                      hover narrow onto one of its own members, and a hover
 *                      outside either one is ignored.
 *   HOME CHAIN         the folders a body is stored inside, which the hover
 *                      keeps lit while the rest of the map steps back.
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
 * Which body the map's lighting should point at — one sentence: A HOVER ONLY
 * COUNTS INSIDE WHAT'S PICKED OUT.
 *
 *   PINNED (`held` — a clicked SQL table) is the subject until she releases
 *   it. No hover moves it: not one of the files at the end of its own ropes
 *   (that would hand the subject to a name the pin itself put there and take
 *   the other names away, the map answering a question she didn't ask at the
 *   exact moment she was reading the answer to the one she did), and not some
 *   dot across the map she was only sweeping past.
 *
 *   SPOTLIT (`inSelection` — an agent's footprint, or a search's hits) is
 *   looser, because it's a TERRITORY rather than a small named set: a hover
 *   on one of its own members narrows onto that member — that file's folders
 *   light, the rest of the footprint steps back — while a hover outside it is
 *   ignored entirely. Pass null when nothing is spotlit.
 *
 *   NOTHING PICKED OUT and the hover is the whole subject, which is what
 *   makes pointing at a dot on a fresh map answer anything at all.
 *
 * Prompts that produced it: "i want things to function with a hybrid of how
 * things work now between the agents and the sql" / "when i have an agent or
 * an sql table selected, i want it to retain the coloration for the agent or
 * sql table that it is connected to" / "[hovering one of the spotlit agent's
 * own files should] map onto that file's folders and the agent's other files
 * step back".
 */
export function wiringTarget(
  hovered: string | null,
  held: string | null,
  inSelection: ((id: string) => boolean) | null,
): string | null {
  if (held !== null) return held;
  if (hovered === null) return null;
  return inSelection === null || inSelection(hovered) ? hovered : null;
}

/**
 * The folders a body is stored INSIDE — nearest first, up to the repo.
 *
 * This is what a hover keeps lit beside the dot itself. Pointing at a file
 * dims the rest of the map so the one dot reads alone, and its chain of
 * containers is the answer to "where is this kept" without her having to read
 * a path off a card: the boxes that stay bright ARE the folders it's in.
 *
 * `parentOf` is the map's tree walked one step at a time. Ids already seen
 * stop the climb, so a tree that somehow points back at itself ends the walk
 * instead of hanging the page.
 *
 * Prompt that produced it: "when i hover over any given file, it dims every
 * other file and folder except for the folders that it's contained within, so
 * that i can see where the file is stored easily".
 */
export function homeChain(id: string, parentOf: (id: string) => string | null): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let parent = parentOf(id);
  while (parent !== null && !seen.has(parent)) {
    chain.push(parent);
    seen.add(parent);
    parent = parentOf(parent);
  }
  return chain;
}
