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
 * everything else scenery. Three tiers, one rule, used by the tree, the ropes
 * and the tethers alike so none of them can drift.
 *
 * The THREADS run on their own version of that rule, one tier shorter: they
 * are drawn only when a hover or a selection names them, and are absent
 * otherwise rather than receding to scenery. See threadPresence for why.
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
 * What a THREAD paints at, as one absolute alpha.
 *
 * The threads are the one channel that sets its alpha outright rather than
 * multiplying, because an ice-cold thread has to be liftable into view when
 * it's the answer to the question — so its heat can't be the only thing
 * deciding whether it's visible.
 *
 * A thread nobody asked about paints at NOTHING. Drawn at rest, the few
 * hundred of them lay a mat of lines over the busiest part of the map — the
 * app code, where the dots she's reading are — and the tree underneath went
 * unreadable. So a thread appears only when something names it: the dot under
 * the cursor owns it, or it's standing on its own (below).
 *
 * `inHoverAnswer` — one of this thread's two ends is the dot being pointed at.
 * `inStandingAnswer` — the thread stands without a cursor: it belongs to what
 * she picked out (a pinned table, a spotlit agent), or it's part of a journey
 * replay, which is itself the thing being watched. Those keep the old resting
 * curve — a floor plus the thread's heat — so pointing at one of their files
 * neither repaints them nor takes them away.
 *
 * Prompt that produced it: "please remove the activity threads from showing
 * unless you are specifically hovering over a dot that has it".
 */
export function threadPresence(
  heat: number,
  inHoverAnswer: boolean,
  inStandingAnswer: boolean,
): number {
  if (inHoverAnswer) return 0.95;
  if (inStandingAnswer) return 0.16 + 0.54 * heat;
  return 0;
}

/**
 * Is a thread skipped entirely rather than drawn?
 *
 * Unasked-for threads are skipped outright — that's the same statement
 * threadPresence makes with a zero alpha, made early so the map doesn't pay
 * to stroke a few hundred invisible arcs every frame.
 *
 * A thread that IS an answer is never dropped on heat: "what is this wired
 * to" is a question about the pipe, not about how recently something went
 * through it. A standing thread keeps the old ice-cold floor, so what a
 * selection or a replay put on screen stays exactly as it was.
 */
export function threadTooCold(
  heat: number,
  inHoverAnswer: boolean,
  inStandingAnswer: boolean,
): boolean {
  if (inHoverAnswer) return false;
  if (inStandingAnswer) return heat <= 0.02;
  return true;
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
 * the file goes from edited to RUN (leanOf, in terrainCanvas.ts) — and the
 * FOLDER OUTLINES the chain runs between wear that very same lean, rolled up
 * over what's inside them. So a chain drawn at full lean through a branch of
 * running code is the colour of the boxes it's connecting, and stops standing
 * out from the one thing it exists to be told apart from.
 *
 * The chain keeps the lean — it still warms with its file, still differs dot
 * to dot — but stops short of gold, landing at a clear orange at the far end,
 * which no folder outline reaches while its subtree is running. The honest
 * cost, stated because a note here must not lie: a pure-run file's dot is
 * gold while its chain is orange, so the two no longer match exactly. The
 * chain's job is to say WHICH DOT IS MINE, and it can only say that in a
 * voice nothing around it is already speaking in.
 *
 * (The first reason for this cap was a different one: the data threads were
 * drawn in gold too, so run-hot chains read as threads — "this is wrong, now
 * some of them are gold". The threads have since moved to their own teal, so
 * that particular collision is gone and only the folder one above is holding
 * the cap up. Lift CHAIN_LEAN_CAP to 1 and chains match their dots exactly.)
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
