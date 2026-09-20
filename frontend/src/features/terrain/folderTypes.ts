import { fileTypeOf, OTHER_FILE_TYPE, type FileType } from './fileTypes';
import type { TerrainNode } from './terrainGraph';

/**
 * folderTypes.ts — what kind of code a folder holds: every file type beneath
 * it, however deep, counted and ranked.
 *
 * This is what a hollow folder's OUTLINE is painted with while the map is on
 * "Types", so the structure says something instead of just holding the files
 * together — a Python package reads teal, `frontend/` reads TypeScript blue,
 * and a folder that's turned into a junk drawer reads grey. Rolled all the
 * way down, not one level: a folder whose direct children are all folders
 * would otherwise have no type at all.
 *
 * It returns the whole RANKING, not just the winner, because the canvas
 * paints the outline in segments around the folder — each type taking the
 * share of the border its file count earns, like GitHub's language bar bent
 * around the shape. That's the honest version of "average the children":
 * mixing the colours themselves would land on a mud that means nothing, or
 * worse, on some third type's colour, because these are CATEGORY colours and
 * the space between two of them isn't a category. Proportion is the thing
 * that can be averaged; hue isn't.
 *
 * Whatever is hiding file dots is felt here too, and that's the point of
 * taking the hidden set as an argument rather than counting the whole tree:
 * the outline describes the files still on screen, not the folder as it is in
 * general. Narrow the date range and the folders re-describe themselves over
 * what's left. The lenses compose instead of being separate modes.
 *
 * "Commonest" settles ties the same way the legend does (fileTypes.ts
 * fileTypeCounts): Other never wins while any real language is present, and
 * an exact tie goes to the alphabetically first label — deterministic, so a
 * folder can't flicker between two colours frame to frame.
 *
 * Beside the ranking, liveliestBeneath answers the other question the canvas
 * asks of a folder: is there anything still ALIVE in here? A folder with
 * nothing live beneath it fades out entirely under Types, rather than drawing
 * a full outline around a subtree that has nothing to show.
 *
 * Used by terrainCanvas.ts; the colours themselves come from fileTypes.ts and
 * are made legible on the live surface by typeDotColor.
 *
 * Prompts that produced it: "make them hollow … make the outline dominant in
 * the child type's color based on whether i have the heat or the activity on
 * or the file type, which are all different settings and views" → "shouldn't
 * the outline be like an average of the children" → "i want the folder node
 * to be hidden / the background color if there are no files highlighted
 * within its tree".
 */

/** How far up a parent chain we'll walk before calling it malformed. The tree
 * is a tree, so this can't trip — it's here so a bad payload can't hang the
 * paint loop. */
const MAX_DEPTH = 64;

/** One file type's share of a folder: the type, and how many files of it sit
 * anywhere beneath that folder. */
export interface TypeShare {
  type: FileType;
  count: number;
}

/**
 * Every file type beneath each folder and repo, ranked commonest first and
 * keyed by node id. Folders with no visible files beneath them are absent
 * from the map, which is how the caller knows to leave them plain.
 */
export function childTypeCounts(
  nodes: readonly TerrainNode[],
  hidden: ReadonlySet<string>,
): Map<string, TypeShare[]> {
  // Parent chains are walked by id, so the lookup has to exist before the
  // walk — one pass to index, one to count.
  const byId = new Map<string, TerrainNode>();
  for (const node of nodes) byId.set(node.id, node);

  // Count every file into all of its ancestors at once. Walking UP from each
  // file is what makes this a deep roll-up rather than a one-level tally, and
  // it costs one short walk per file instead of a whole subtree scan per
  // folder.
  const counts = new Map<string, Map<FileType, number>>();
  for (const node of nodes) {
    // Only plain files have a type. The pond tile and the table shelves are
    // their own kind of thing, and a hidden file isn't on screen to be
    // described.
    if (node.kind !== 'file' || !node.file || node.file.days || node.file.table) continue;
    if (node.path === undefined || hidden.has(node.id)) continue;
    const type = fileTypeOf(node.path);
    let ancestorId = node.parentId;
    for (let step = 0; ancestorId !== null && step < MAX_DEPTH; step += 1) {
      let tally = counts.get(ancestorId);
      if (tally === undefined) {
        tally = new Map();
        counts.set(ancestorId, tally);
      }
      tally.set(type, (tally.get(type) ?? 0) + 1);
      ancestorId = byId.get(ancestorId)?.parentId ?? null;
    }
  }

  // Rank each folder's tally. Same ordering as the legend's (fileTypes.ts
  // fileTypeCounts), so the biggest share of a folder's outline is the type
  // at the top of the list for what's inside it.
  const ranked = new Map<string, TypeShare[]>();
  for (const [folderId, tally] of counts) {
    const shares = [...tally.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => {
        // Other never outranks a real language, however many of it there are:
        // a grey outline says "junk drawer", and a folder of thirty images
        // and one module is better described by the module.
        if (a.type === OTHER_FILE_TYPE) return 1;
        if (b.type === OTHER_FILE_TYPE) return -1;
        // An exact tie goes to the alphabetically first label — deterministic,
        // so a folder can't flicker between two colours frame to frame.
        return b.count - a.count || a.type.label.localeCompare(b.type.label);
      });
    ranked.set(folderId, shares);
  }
  return ranked;
}

/**
 * How alive the liveliest file beneath each folder is, 0..1, keyed by node id.
 *
 * This is what lets a folder go out with its contents. The map already fades
 * a stale file dot into the sky; a folder that kept a full outline around a
 * subtree of faded dots would be drawing a box around nothing. So a folder is
 * exactly as present as the most alive thing inside it: one fresh file keeps
 * the whole branch lit, and a branch where everything has gone stale — or has
 * been taken off the map by the date range — goes with it.
 *
 * MAX and not a sum or a mean, deliberately: a folder of four hundred dead
 * files and one that changed this morning is a folder she's working in, and
 * an average would bury that one file under the other four hundred.
 *
 * Aliveness comes in as a callback because it's the CANVAS's notion (the
 * union of the two heats, on the window the Heat bar is set to) and lives
 * over there — passing it keeps this module from reaching back into the
 * painter, which imports it.
 *
 * Folders with no visible file beneath them are absent from the map, which
 * the caller reads as zero: gone.
 */
export function liveliestBeneath(
  nodes: readonly TerrainNode[],
  hidden: ReadonlySet<string>,
  aliveness: (node: TerrainNode) => number,
): Map<string, number> {
  // Same index and the same upward walk as childTypeCounts above — one short
  // walk per file, rather than a subtree scan per folder.
  const byId = new Map<string, TerrainNode>();
  for (const node of nodes) byId.set(node.id, node);

  const liveliest = new Map<string, number>();
  for (const node of nodes) {
    // Only plain files carry aliveness. The pond tile and the table shelves
    // are their own kind of thing, and a hidden file isn't on the map to keep
    // anything lit.
    if (node.kind !== 'file' || !node.file || node.file.days || node.file.table) continue;
    if (hidden.has(node.id)) continue;
    const alive = aliveness(node);
    let ancestorId = node.parentId;
    for (let step = 0; ancestorId !== null && step < MAX_DEPTH; step += 1) {
      const best = liveliest.get(ancestorId) ?? 0;
      if (alive > best) liveliest.set(ancestorId, alive);
      else if (!liveliest.has(ancestorId)) liveliest.set(ancestorId, alive);
      ancestorId = byId.get(ancestorId)?.parentId ?? null;
    }
  }
  return liveliest;
}
