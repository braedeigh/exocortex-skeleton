import type { TerrainFile } from './api';
import type { TerrainNode } from './terrainGraph';

/**
 * runGlow.ts — the rule behind the map's Active bar: which file dots GLOW,
 * given how long ago each file last RAN.
 *
 * Two things about it are decisions rather than defaults, and both are worth
 * knowing before reading the code:
 *
 * **It measures runs, not edits.** The map already has two fires and they are
 * already split — the ember channel is editing, the gold channel is running
 * (terrainGraph.ts RUN_WINDOW_SECONDS). The Active bar is the gold question
 * with a window she can move, so "active" here means EXECUTED, and a file
 * edited five minutes ago but never run does not glow. That is narrower than
 * the sense this rule once used ("edited OR run"), and the narrowing is the
 * point: one bar, one meaning.
 *
 * Owner, 2026-09-20: "heat map is already edits, activity map is already runs".
 *
 * **It hides nothing.** An earlier version returned dots to take OFF the map,
 * and on a runs signal that is brutal: the sensor is Python-only
 * (routes/terrain.py — "the sensor can't see the browser, so no .tsx ever gets
 * a `ran`"), so cutting to "ran lately" would blank every .tsx, .css, .md and
 * .json dot plus every .py that has been quiet. The map would drop from
 * thousands of dots to dozens and read as broken. So this returns the dots to
 * LIGHT UP instead, and everything else stays where it is at normal
 * brightness.
 *
 * Owner, 2026-09-20: "i just want them to glow, not hide anything".
 *
 * The only thing that still takes file dots off this map is the date range
 * (TerrainPage filesOutsideRange), and even that only stops the canvas
 * PAINTING them — the force layout never changes, so a dot that comes back
 * comes back to the same spot. Nothing in this file goes near the layout.
 *
 * Used by TerrainPage.tsx, which hands the result to terrainCanvas.ts
 * setGlowFiles; the bar itself is drawn by TerrainHeatBar.tsx, on the axis in
 * activeScale.ts.
 */

/**
 * When a file last ran, in unix seconds — the newest bucket the run sensor has
 * for it, or null when it has never run on record (which is every file the
 * sensor cannot see, not only the idle ones).
 *
 * Only the NEWEST stamp is read, which is what makes this trustworthy at any
 * age: runtime_sensor.py keeps a capped ring of buckets per file (TOUCH_CAP),
 * and a full ring drops its oldest, never its newest. "Last ran three days
 * ago" survives the file having run ten thousand times since.
 */
export function fileLastRun(file: TerrainFile): number | null {
  if (!file.ran || file.ran.length === 0) return null;
  return Math.max(...file.ran);
}

/**
 * Pick the file dots to light up: the ones whose last run falls inside the
 * window. Only files ever glow — folders, repos and agents are the map's
 * skeleton, not things that run. The pond tile and table nodes
 * (tableNodes.ts) are skipped for the reason they're skipped everywhere else:
 * they are synthetic files, with no run history to be inside a window BY.
 */
export function filesGlowingByRun(
  nodes: readonly TerrainNode[],
  windowSeconds: number,
  nowSeconds: number,
): Set<string> {
  const glowing = new Set<string>();
  const cutoff = nowSeconds - windowSeconds;
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.file || node.file.days || node.file.table) continue;
    const lastRun = fileLastRun(node.file);
    if (lastRun !== null && lastRun >= cutoff) glowing.add(node.id);
  }
  return glowing;
}
