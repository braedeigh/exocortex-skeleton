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

/**
 * Which body the wiring highlight should point at, once something is PINNED.
 *
 * `highlightTarget` lets any hover outrank the pin, which is right while
 * nothing is pinned down and wrong the moment something is: a pinned table
 * names the code files at the end of its ropes, and moving the cursor onto
 * one of those names would hand the subject to that file and take the other
 * names away — the map answering a question she didn't ask, at the exact
 * moment she was reading the answer to the one she did.
 *
 * So a pin HOLDS while the cursor is inside its own answer, and only gives way
 * to a hover on something outside it. `isInAnswer` is that test — everything
 * the pinned body is wired to, itself included. This is what a spotlit agent
 * already does for free: hovering one of its files can't un-spotlight it,
 * because the spotlight isn't a hover at all.
 *
 * Prompt that produced it: "i want things to function with a hybrid of how
 * things work now between the agents and the sql".
 */
export function wiringTarget(
  hovered: string | null,
  held: string | null,
  isWired: (id: string) => boolean,
  isInAnswer: (id: string) => boolean,
): string | null {
  if (held !== null && hovered !== null && isWired(held) && isInAnswer(hovered)) return held;
  return highlightTarget(hovered, held, isWired);
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
