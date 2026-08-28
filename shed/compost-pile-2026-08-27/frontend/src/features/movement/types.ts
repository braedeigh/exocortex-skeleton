/** Shapes for movement.json (routes/movement.py) as delivered by
 * GET /api/data/movement — routines (named sequences) of moves, each move
 * optionally carrying a demo-video URL, a dose (reps/hold) and a cue note. */

export interface MovementMove {
  id: string;
  name: string;
  /** Video URL — usually YouTube; empty string when the move has no video. */
  url?: string;
  /** Reps / hold, e.g. "20–30s · 1–2×/side". */
  dose?: string;
  /** Optional cue, e.g. "nose toward armpit". */
  note?: string;
}

export interface MovementRoutine {
  id: string;
  name: string;
  /** Optional note (how to approach the routine). */
  note?: string;
  moves?: MovementMove[];
}

/** The slice of /api/data/movement this feature reads. The endpoint also
 * returns common dashboard data (dev_notes, idea_notes, tab_todos, …) which
 * we deliberately leave untyped and untouched — optimistic updaters spread
 * the whole object so nothing extra is dropped from the cache. */
export interface MovementData {
  movement?: {
    routines?: MovementRoutine[];
  } | null;
}
