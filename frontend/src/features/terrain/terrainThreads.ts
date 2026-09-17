/**
 * terrainThreads.ts — the threads between files that touch each other.
 *
 * WHAT A THREAD IS. Two files are threaded when one WRITES a store collection
 * and the other READS it: `routes/todos.py` writes `todos`, something else
 * reads `todos`, so data made by the first arrives at the second. That is a
 * real relationship between two dots on the map — not "these sit in the same
 * folder" (the tree already draws that) and not "an agent touched both" (the
 * session tethers already draw that), but "what one of these makes, the other
 * one eats".
 *
 * WHERE IT COMES FROM, AND WHY NOTHING NEW HAD TO BE BUILT. GET /api/creek
 * already returns exactly the two halves this needs: `files[].calls`, the
 * static scan of every store.read/write/mutate call site with its line number
 * and collection, and `collections[].last_write`, the write journal's exact
 * timestamp for when that collection last actually changed. So the threads are
 * a pure function of a payload the app was already serving — this file does
 * arithmetic, and adds no endpoint, no table, and no Python.
 *
 * IT ONLY EVER COVERS THE SKELETON REPO. The creek's static scan walks this
 * repo's own sources, so every thread lands on a `skeleton:file:<path>` node.
 * The vault has no code to scan, which is correct rather than a gap.
 *
 * THE HEAT IS THE FILTER, and this is the load-bearing design choice. There are
 * a few hundred threads; drawn all at once at equal weight they are a hairball
 * that fights the map's own tree. So a thread is lit on the SAME schema as the
 * dots — decayed recency on the map's live lens — which means a thread whose
 * collection hasn't moved in weeks is effectively invisible, and one that moved
 * a minute ago is bright. Nothing is hidden by a rule; the cold ones simply
 * fade out the way a cold dot does. The map filters itself by being honest.
 *
 * WHAT THE CLOCK ACTUALLY MEASURES. A thread's recency is its COLLECTION's last
 * write, not either file's. That's the truthful reading: the thread is the data
 * moving, so it is fresh when the data moved, whoever's code moved it. Exact to
 * the second where the write journal has seen it (`last_write`), falling back
 * to the day-coarse counters (`last_write_day`) for anything older than the
 * journal's own life, and dark when there is no evidence at all — the same
 * prefer-exact-then-fall-back rule creekMath.freshnessAt follows.
 *
 * Used by TerrainPage.tsx, drawn by terrainCanvas.ts. Tested in
 * terrainThreads.test.ts.
 *
 * Prompt that produced it: "eventually put small threads between all the files
 * that touch each other" / "I'm wanting the threads to light up on the same
 * schema as the dots."
 */
import type { CreekData } from '../creek/api';

/** The repo the creek's static scan covers — its call sites are all in this
 * repo's own sources, so every thread endpoint is a node in this territory. */
export const THREAD_REPO_ID = 'skeleton';

export interface TerrainThread {
  /** Node id of the file that WRITES the collection. */
  sourceId: string;
  /** Node id of the file that READS it. */
  targetId: string;
  /** The collection the data passes through — what the thread is made of. */
  collection: string;
  /** When that collection last actually changed, as unix seconds; null when
   * neither the journal nor the counters have ever seen it move. */
  lastWrite: number | null;
  /** 0..1 lit-ness on the map's live lens. Filled in by heatThreads. */
  t: number;
}

function nodeId(path: string): string {
  return `${THREAD_REPO_ID}:file:${path}`;
}

/**
 * A collection's last-write as unix seconds, preferring the journal's exact
 * stamp and falling back to the day-coarse counter.
 *
 * The day fallback is read as that day's NOON, not its midnight. A day-coarse
 * stamp means "sometime on the 26th", and midnight is the earliest reading of
 * that span rather than the likeliest one — anchoring at noon halves the worst
 * error instead of always guessing early and making everything look staler
 * than it is.
 */
export function collectionLastWrite(
  exact: string | null,
  day: string | null,
): number | null {
  if (exact) {
    const ms = Date.parse(exact);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  if (day) {
    const ms = Date.parse(`${day}T12:00:00`);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

/**
 * Every writer-to-reader pair the creek payload implies, one per file pair.
 *
 * A pair that shares SEVERAL collections keeps only the freshest of them: two
 * files are threaded once, and the thread should speak for the most recent
 * thing that actually travelled it. A file is never threaded to itself — a
 * module that writes what it reads is having a conversation with its own state,
 * which is a fact about that dot, not a line between two.
 */
export function buildThreads(creek: CreekData | null | undefined): TerrainThread[] {
  if (!creek) return [];

  const lastWrite = new Map<string, number | null>();
  for (const c of creek.collections) {
    lastWrite.set(c.id, collectionLastWrite(c.last_write, c.last_write_day));
  }

  const writers = new Map<string, Set<string>>();
  const readers = new Map<string, Set<string>>();
  for (const f of creek.files) {
    for (const call of f.calls) {
      const side = call.verb === 'read' ? readers : writers;
      let set = side.get(call.collection);
      if (!set) {
        set = new Set();
        side.set(call.collection, set);
      }
      set.add(f.path);
    }
  }

  // Keyed by the ordered pair, so a pair sharing several collections collapses
  // to its freshest one rather than stacking identical lines on top of itself.
  const best = new Map<string, TerrainThread>();
  for (const [collection, writerPaths] of writers) {
    const readerPaths = readers.get(collection);
    if (!readerPaths) continue;
    const when = lastWrite.get(collection) ?? null;
    for (const w of writerPaths) {
      for (const r of readerPaths) {
        if (w === r) continue;
        const key = `${w} ${r}`;
        const prev = best.get(key);
        if (prev && (prev.lastWrite ?? -Infinity) >= (when ?? -Infinity)) continue;
        best.set(key, {
          sourceId: nodeId(w),
          targetId: nodeId(r),
          collection,
          lastWrite: when,
          t: 0,
        });
      }
    }
  }

  // Stable order so a re-render can never reshuffle what's drawn on top.
  return [...best.values()].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId),
  );
}

/**
 * Light the threads on the map's live lens: the SAME exponential decay
 * computeFileHeat runs on a dot, so a thread and a dot of equal age fade at the
 * same rate and the two read as one system.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is put that decay through normalizeHeat, and
 * this was a real bug before it was a decision. A dot's heat is a SUM over many
 * touches, so it needs a saturating curve to stay bounded — and that curve maps
 * a heat of 1 to 0.5, on the way to 1 only as touches pile up. A thread has
 * exactly ONE event behind it (its collection's last write), so its heat can
 * never exceed 1, so through normalizeHeat it could never exceed 0.5: every
 * thread on the map was drawn from the middle of the ramp downward, and the
 * gold at the top was literally unreachable. They could not get more yellow
 * however recently they fired, which is precisely what it looked like.
 *
 * So a thread uses the raw decay directly: fired just now is 1 and full gold,
 * one half-life ago is 0.5, two is 0.25. The right parity between a thread and
 * a dot was never "identical arithmetic" — it's that both are brightest when
 * newest and fade on the same clock.
 *
 * Returned fresh rather than mutated in place: the page recomputes this on
 * every breath tick, and a caller holding last tick's array while this one is
 * half-written is the kind of bug that only ever shows up as a flicker.
 */
export function heatThreads(
  threads: readonly TerrainThread[],
  halfLifeSeconds: number,
  nowSeconds: number = Date.now() / 1000,
): TerrainThread[] {
  if (!(halfLifeSeconds > 0)) return threads.map((th) => ({ ...th, t: 0 }));
  return threads.map((th) => {
    if (th.lastWrite === null) return { ...th, t: 0 };
    const age = nowSeconds - th.lastWrite;
    if (!Number.isFinite(age)) return { ...th, t: 0 };
    return { ...th, t: Math.pow(2, -Math.max(0, age) / halfLifeSeconds) };
  });
}
