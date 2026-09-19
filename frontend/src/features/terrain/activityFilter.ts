import type { TerrainFile } from './api';
import { fileLastTouch, type TerrainNode } from './terrainGraph';

/**
 * activityFilter.ts — the rule behind the map's All / Recent / Old switch:
 * which file dots to hide, given how long ago each file was last active.
 *
 * "Active" means edited OR run, whichever is later — the same two fires the
 * map's red and gold stand for. The cutoff is not a setting of its own: it is
 * the Heat slider's window, the one "how far back" control the map already
 * has. So Recent is exactly the dots the heat colours would light, and Old is
 * exactly the ones they'd leave as ash.
 *
 * TWO CUTS RUN THROUGH THIS ONE RULE, because they're the same question asked
 * against two different edges — the page calls it twice and unions the
 * answers (TerrainPage, hiddenFiles):
 *
 *   the HEAT cut    filter 'recent' against the heat slider's window —
 *                   "only what's still lit", the colour edge made into a cut
 *   the ACTIVE cut  filter 'recent' or 'old' against the Active slider's own
 *                   window — a second edge she moves independently
 *
 * Each is off unless she turns it on, on both views, and each view keeps its
 * own settings. Nothing here hides anything by default: the map opens whole.
 *
 * Owner, 2026-09-19: "i want to be able to filter by both the heat map and by
 * the recently active toggle ... move both independently and also filter by
 * one or both" / "it lives on both and retains the behavior of each view." 
 *
 * It returns the dots to HIDE rather than a smaller map, on purpose. The
 * canvas (terrainCanvas.ts setHiddenFiles) keeps hidden dots in the layout
 * and just doesn't paint them, so flipping Recent ↔ Old moves nothing: the
 * two views are halves of one picture, and a file is in the same spot in
 * whichever half it shows up in.
 *
 * Used by TerrainPage.tsx; the switch itself is drawn by TerrainHeatBar.tsx.
 *
 * Prompt that produced it: "another toggle to hide any dots that haven't been
 * modified or active in the past X amount of time and then i can also see
 * things that haven't been active like switch between the two when on the
 * file type overview. so i can identify old files easily and what kind they
 * are".
 */

/** 'all' hides nothing; 'recent' keeps files active inside the window; 'old'
 * keeps the ones that weren't. */
export type ActivityFilter = 'all' | 'recent' | 'old';

/** Which side of its edge a cut keeps. 'all' isn't a side — that's the cut
 * being off, which the page says by not calling this rule at all. */
export type ActivitySide = Exclude<ActivityFilter, 'all'>;

/** When a file was last active, in unix seconds: its latest edit (git touch
 * or an agent's write) or its latest run, whichever is later. null when
 * there's no record of either. */
export function fileLastActive(file: TerrainFile): number | null {
  const lastTouch = fileLastTouch(file);
  const lastRun = file.ran && file.ran.length > 0 ? Math.max(...file.ran) : null;
  if (lastTouch === null) return lastRun;
  if (lastRun === null) return lastTouch;
  return Math.max(lastTouch, lastRun);
}

/**
 * Pick the file dots to hide. Only files are ever hidden — folders, repos and
 * agents stay, so the map keeps its skeleton and the dots that remain still
 * sit somewhere recognisable. A file with no recorded activity counts as old.
 * The pond tile is never hidden: it is the journal's one body on the map, a
 * landmark rather than a file to be sorted. Tables (tableNodes.ts) are never
 * hidden either — they have no edit history to be recent or old BY.
 */
export function filesHiddenByActivity(
  nodes: readonly TerrainNode[],
  filter: ActivityFilter,
  windowSeconds: number,
  nowSeconds: number,
): Set<string> {
  const hidden = new Set<string>();
  if (filter === 'all') return hidden;
  const cutoff = nowSeconds - windowSeconds;
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.file || node.file.days || node.file.table) continue;
    const lastActive = fileLastActive(node.file);
    const isRecent = lastActive !== null && lastActive >= cutoff;
    if (filter === 'recent' ? !isRecent : isRecent) hidden.add(node.id);
  }
  return hidden;
}
