/**
 * hoverLayers.ts — how the map holds TWO answers on screen at once.
 *
 * Pointing at a file used to REPLACE whatever was picked out: pin a table or
 * spotlight an agent, then hover one of the files it named, and the map threw
 * the selection's own wiring away to describe that one file. The selection
 * collapsed to a single dot the moment she pointed at one of its members.
 *
 * Now the hover ADDS instead. Two answers stand together and are told apart by
 * presence, not by going away: the hovered file's own lines at full strength,
 * the selection's remaining lines a step quieter but still readable, and
 * everything else scenery. Three tiers, one rule, used by all four line
 * channels (tree, threads, ropes, tethers) so none of them can drift.
 *
 * The second half is what keeps those two tiers legible: the lit CHAIN — the
 * tree lines from a hovered file up to the folders it's kept in — is drawn in
 * that file's own colour, and it must never wander into a hue that already
 * means something else on this map. See chainLean.
 *
 * Read by terrainCanvas.ts only. Pure arithmetic, so it's tested here rather
 * than in a browser.
 *
 * Prompt that produced it: "when i'm hovering over a dot that is selected by
 * an sql table or an agent, it can display the connection with the table or
 * agent as well as the connections to other tables or files" / "this is
 * wrong, now some of them are gold".
 */

/** The three tiers a line can be in while a file hover is up. */
export const HOVER_ANSWER = 1;
/** The selection's own lines: quiet, still readable. Not 0.22 — a line at
 * scenery strength has effectively been withdrawn, and withdrawing the
 * selection is the exact thing this file exists to stop. */
export const SELECTION_ANSWER = 0.55;
/** Everything the hover didn't name and the selection didn't either. */
export const SCENERY = 0.22;

/**
 * How much presence a line keeps while a FILE HOVER is up.
 *
 * Multiplied into whatever alpha the channel already chose, never assigned, so
 * a channel's own weighting (a read rope is fainter than a write rope; a cold
 * tree line is fainter than a hot one) still has the last word.
 *
 * `inHoverAnswer` — this line is the hovered file's own.
 * `inSelectionAnswer` — this line belongs to what was picked out: the pinned
 * table's other ropes, the spotlit agent's other tethers, the threads between
 * the files either of them named.
 */
export function hoverRecession(inHoverAnswer: boolean, inSelectionAnswer: boolean): number {
  if (inHoverAnswer) return HOVER_ANSWER;
  if (inSelectionAnswer) return SELECTION_ANSWER;
  return SCENERY;
}

/**
 * What a THREAD paints at, as one absolute alpha across all three tiers.
 *
 * The threads are the one channel that sets its alpha outright rather than
 * multiplying, because an ice-cold thread has to be liftable into view when
 * it's the answer to the question — so its heat can't be the only thing
 * deciding whether it's visible.
 *
 * The curve is a floor plus the thread's heat, and a SELECTION's threads keep
 * exactly that curve while a hover is up — the hover doesn't repaint them, it
 * simply doesn't take them away. Only two things move: the hovered file's own
 * threads jump to the front, and everything neither answer named drops to a
 * trace.
 */
export function threadPresence(
  heat: number,
  inHoverAnswer: boolean,
  inSelectionAnswer: boolean,
  hoverUp: boolean,
): number {
  const resting = 0.16 + 0.54 * heat;
  if (!hoverUp) return resting;
  if (inHoverAnswer) return 0.95;
  if (inSelectionAnswer) return resting;
  return 0.05;
}

/**
 * Is a thread cold enough to skip drawing entirely?
 *
 * The heat IS the filter on this map — nothing is capped by count — so a
 * thread that hasn't moved arrives at an alpha that rounds to nothing and is
 * dropped rather than painted. But a thread that's part of an ANSWER is never
 * dropped on heat: "what is this wired to" is a question about the pipe, not
 * about how recently something went through it.
 */
export function threadTooCold(
  heat: number,
  inHoverAnswer: boolean,
  inSelectionAnswer: boolean,
  hoverUp: boolean,
): boolean {
  if (inHoverAnswer) return false;
  // A selection's threads are culled on the SAME floor they were culled on
  // before the hover arrived, so pointing at one of its files neither adds
  // threads nor takes any away.
  if (inSelectionAnswer) return heat <= 0.02;
  return hoverUp ? heat <= 0.25 : heat <= 0.02;
}

/** The furthest toward GOLD a chain line is allowed to lean. */
export const CHAIN_LEAN_CAP = 0.4;
/** The least glow a chain line is drawn at, however cold its file. */
export const CHAIN_GLOW_FLOOR = 0.35;

/**
 * Keep the chain OUT of the gold channel.
 *
 * The chain wears its file's own colour so the path up to where that file
 * lives can be followed by eye. A file dot's hue leans from ember to gold as
 * the file goes from edited to RUN (leanOf, in terrainCanvas.ts) — and a
 * file that ran today wears very nearly the same gold the data THREADS are
 * drawn in, off the same ramp. So the chains of run-hot files read as
 * threads: "this is wrong, now some of them are gold".
 *
 * Gold is a line meaning on this map already, and red is not. So the chain
 * keeps the lean — it still warms with the file, still differs dot to dot —
 * but stops short of gold, landing at a clear orange at the far end. The
 * honest cost, stated because a note here must not lie: a pure-run file's
 * dot is gold while its chain is orange. They no longer match exactly. The
 * chain says WHICH DOT IS MINE, and it can only say that in a voice nothing
 * else on the map is already speaking in.
 */
export function chainLean(lean: number): number {
  return Math.min(Math.max(lean, 0), 1) * CHAIN_LEAN_CAP;
}

/**
 * Lift a cold file's chain into view.
 *
 * A stale dot is faint by design, so a chain drawn at the dot's own strength
 * was faintest for exactly the file whose home is hardest to find. The floor
 * is on the CHAIN only — the dot it leaves stays as cold as it truly is, so
 * nothing about the heat reading changes.
 */
export function chainGlow(glow: number): number {
  return Math.max(CHAIN_GLOW_FLOOR, Math.min(Math.max(glow, 0), 1));
}
