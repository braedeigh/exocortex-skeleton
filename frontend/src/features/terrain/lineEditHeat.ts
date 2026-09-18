/**
 * lineEditHeat.ts — the map's red (EMBER) channel brought down to one line
 * of code. A file on the terrain glows red by how recently git touched it;
 * with the file pane's "edits" toggle on, each LINE glows the same way by
 * when it was last edited (GET /api/observatory/terrain/file/edits, one
 * git-blame stamp per line — see routes/terrain.py `_terrain_line_edits`).
 *
 * Same curve as the map, on purpose, so the pane never disagrees with the
 * dot it was opened from: heat = 2^-(age / half_life), half_life a third of
 * the window (terrainGraph.ts windowToHalfLife), and ZERO past the window's
 * edge — the heat bar rounds that last sliver off the same way
 * (heatTrackStops), so "the thumb is the edge of the colour" holds here too.
 *
 * One difference from a file's heat: a line has exactly ONE last-edit time,
 * not a pile of touches, so this returns the raw decay rather than the
 * saturating normalizeHeat() the map uses to sum many touches. A line edited
 * just now is fully red; a file with one touch just now sits at half. That's
 * right — the ramp's top should be reachable by a single edit, or nothing in
 * the pane would ever be fully lit.
 *
 * Prompt that produced it: "can those displays show when the most recent
 * code was edited by a toggleable red color like on the terrain map".
 */
import { windowToHalfLife } from './terrainGraph';

/**
 * 0..1 heat for a line last edited at `editedAt` (unix seconds), seen from
 * `nowSeconds`, on a window of `windowSeconds`. 0 for a missing/zero stamp,
 * a non-positive window, or an edit older than the window; 1 for an edit
 * right now (or a clock skew that puts it in the future).
 */
export function lineEditHeat(editedAt: number | null | undefined, nowSeconds: number, windowSeconds: number): number {
  if (!editedAt || editedAt <= 0 || windowSeconds <= 0) return 0;
  const age = nowSeconds - editedAt;
  if (!Number.isFinite(age)) return 0;
  if (age <= 0) return 1;
  if (age > windowSeconds) return 0;
  return Math.pow(2, -age / windowToHalfLife(windowSeconds));
}
