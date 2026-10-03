/**
 * fileGrids.ts — a folder's code files laid out as a grid of dots, the one
 * edited longest ago at the top-left and the one edited most recently at the
 * bottom-right.
 *
 * Pure geometry and ordering: no DOM, no physics, no canvas. TerrainPage asks
 * `gridFolders` which files go in which folder's grid, in what order;
 * terrainCanvas.ts pins each dot to its cell (`gridArrangement`) around its
 * folder node, draws the folder outline as the grid's frame
 * (`gridFrameOutline`), and gives the folder a collision body the size of
 * that frame (`gridBodyRadius`), so the rest of the map flows around the whole
 * grid. It's the same move the coils make (coilFolders.ts, spiralLayout.ts):
 * the folder floats, and its dots ride it at fixed offsets.
 *
 * ORDER IS LAST EDIT — the same fact the dot's colour shows. A file's place
 * in its grid is when it was last edited: its newest commit, or an agent's
 * write since then. So the grid reads as a gradient: cold in the top-left,
 * hot in the bottom-right. Editing a file moves it to the end and closes the
 * gap it left; that reshuffle is the point, not a cost.
 *
 * THE FILL IS DOWN THE COLUMNS OF A SQUARE. The grid is as many cells tall
 * as the smallest square that holds every file (ten files → 4 tall). Dots
 * fill the left column top to bottom, then the next column to its right, and
 * so on, so the newest file is the last dot of the last column. The square
 * grows as the folder does.
 *
 * SIZE IS FILE SIZE. Each dot is fileRadius(bytes) (terrainCanvas.ts, a log
 * scale), and the grid's pitch is fixed to fit the BIGGEST possible dot with
 * its touch ring, so every grid on the map has the same spacing and a big
 * file arriving never respaces a grid.
 *
 * Tested in fileGrids.test.ts.
 *
 * Prompt that produced it: "I want my terrain files instead stored in grids.
 * [...] I want them to be dot grids and scaled by size = size of file. I want
 * all code/ app files organized this way on the terrain." → "the dots should
 * be colored by when they were last edited, and they should be arranged with
 * the oldest edited in the top left corner, moving down in columns to more
 * newly edited files, with another row of more newly edited files on the
 * right, until the newest files on the bottom right [...] they should be
 * growing squares."
 */
import type { TerrainData, TerrainFile } from './api';
import type { TerrainNode } from './terrainGraph';
import { NODE_GAP } from './ringBodies';

/** Centre-to-centre distance between neighbouring dots, in world units. Two
 * of the biggest dots (radius 13) each wearing a hugging ring
 * (GRID_RING_GAP) exactly touch at this pitch. */
export const GRID_PITCH = 30;

/** How far a touch ring sits outside a dot on a grid. Tighter than the
 * floating map's moat (ringBodies.ts RING_GAP): a grid dot is pinned, so its
 * ring can't shove neighbours away — it has to fit inside its cell. */
export const GRID_RING_GAP = 2;

/** Clear space between the outermost dots and the frame. */
export const GRID_PAD = 8;

/** Height of the folder's tab along the top of the frame, in world units. */
export const GRID_TAB = 12;

/** Repos that keep the floating layout. The vault holds her notes and data,
 * not code; its time-stamped folders already have coils. */
export const GRID_SKIP_REPOS: ReadonlySet<string> = new Set(['vault']);

/** A rectangle in world units. */
export interface GridRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How many cells tall a grid of `count` dots is: the side of the smallest
 * square that holds them all. */
export function gridSide(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

/**
 * Which cell the index-th dot sits in, in a grid of `count`: down the first
 * column, then down the next one to its right.
 */
export function gridCell(index: number, count: number): { col: number; row: number } {
  const side = gridSide(count);
  return { col: Math.floor(index / side), row: index % side };
}

export interface GridArrangement {
  /** One spot per dot, in grid order, relative to the frame's CENTRE — the
   * point the folder node sits on. */
  spots: { x: number; y: number }[];
  /** The frame around the dots, relative to the same centre. */
  frame: GridRect;
  /** Where cell 0 sits relative to the centre. When a grid grows, the canvas
   * moves the folder by the change in this, so the dots already there stay
   * put on the map. */
  origin: { x: number; y: number };
}

/** Lay `count` dots out down the columns of a square, and the frame that
 * holds them. */
export function gridArrangement(count: number, pitch: number = GRID_PITCH): GridArrangement {
  // Work in cell space first (cell 0 at 0,0), measuring how far the grid
  // reaches, then shift everything so the frame's centre is the origin.
  const cells = Array.from({ length: count }, (_, i) => gridCell(i, count));
  let cols = 1;
  let rows = 1;
  for (const cell of cells) {
    cols = Math.max(cols, cell.col + 1);
    rows = Math.max(rows, cell.row + 1);
  }
  const half = pitch / 2;
  const left = -half - GRID_PAD;
  const top = -half - GRID_PAD - GRID_TAB;
  const right = (cols - 1) * pitch + half + GRID_PAD;
  const bottom = (rows - 1) * pitch + half + GRID_PAD;
  const centreX = (left + right) / 2;
  const centreY = (top + bottom) / 2;
  return {
    spots: cells.map((cell) => ({ x: cell.col * pitch - centreX, y: cell.row * pitch - centreY })),
    frame: { left: left - centreX, top: top - centreY, right: right - centreX, bottom: bottom - centreY },
    origin: { x: -centreX, y: -centreY },
  };
}

/** The circle a grid's folder holds in the physics: the frame's corners,
 * plus the ordinary gap. The collider only knows circles, so a square-ish
 * grid is the shape that wastes least ground. */
export function gridBodyRadius(frame: GridRect): number {
  return Math.hypot((frame.right - frame.left) / 2, (frame.bottom - frame.top) / 2) + NODE_GAP;
}

/**
 * The frame drawn around a grid: a folder, with its tab across the left of
 * the top edge and the body's top stepping down behind it — the same shape as
 * a lone folder (terrainCanvas.ts folderOutline), but sized to the grid and
 * with a tab of fixed height rather than a share of a box that can now be
 * hundreds of units tall.
 */
export function gridFrameOutline(rect: GridRect, tab: number = GRID_TAB): [number, number][] {
  const width = rect.right - rect.left;
  const tabRight = rect.left + Math.min(width * 0.44, Math.max(width * 0.3, 90));
  const bodyTop = rect.top + tab;
  return [
    [rect.left, rect.top],
    [tabRight, rect.top],
    [tabRight + tab * 0.8, bodyTop],
    [rect.right, bodyTop],
    [rect.right, rect.bottom],
    [rect.left, rect.bottom],
  ];
}

/**
 * Where a line from `from` (inside `rect`) toward `to` crosses the rect's
 * edge — so a rope between two grids can start and end at their frames
 * instead of running through their dots. Returns `to` itself when it lies
 * inside the rect too.
 */
export function rectExit(
  from: { x: number; y: number },
  to: { x: number; y: number },
  rect: GridRect,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let along = 1;
  if (dx > 0) along = Math.min(along, (rect.right - from.x) / dx);
  if (dx < 0) along = Math.min(along, (rect.left - from.x) / dx);
  if (dy > 0) along = Math.min(along, (rect.bottom - from.y) / dy);
  if (dy < 0) along = Math.min(along, (rect.top - from.y) / dy);
  along = Math.max(0, along);
  return { x: from.x + dx * along, y: from.y + dy * along };
}

/**
 * When a file was last edited, in unix seconds: its newest commit, or an
 * agent's last write to it if that is later — the same two facts the dot's
 * colour is made from. Null when neither is on record; the grid treats that
 * as newest, since a file git has never seen is one that was just made.
 *
 * Must be read off the payload BEFORE the date dial strips touches
 * (filterTerrainData), or narrowing the dates would re-order every grid.
 */
export function fileLastEdit(file: TerrainFile): number | null {
  let edited = -Infinity;
  for (const ts of file.touches) if (ts > edited) edited = ts;
  for (const s of file.sessions) {
    if ((s.writes ?? 0) <= 0 || typeof s.last !== 'string') continue;
    const ms = Date.parse(s.last);
    if (Number.isFinite(ms)) edited = Math.max(edited, ms / 1000);
  }
  return Number.isFinite(edited) ? edited : null;
}

/** Every file's last edit in a payload, by the node id the graph gives it. */
export function fileLastEdits(data: TerrainData): Map<string, number | null> {
  const edits = new Map<string, number | null>();
  for (const repo of data.repos) {
    for (const file of repo.files) edits.set(`${repo.id}:file:${file.path}`, fileLastEdit(file));
  }
  return edits;
}

/** One grid as the canvas asks for it: the folder at its centre, and its
 * files in grid order, the one edited longest ago first. */
export interface GridPins {
  folderId: string;
  ids: string[];
}

/**
 * Group the graph's code files into one grid per folder, each ordered by
 * last edit, longest ago first.
 *
 * Left out: files in GRID_SKIP_REPOS, anything in `skipIds` (the coils' dots,
 * which have their own spiral), and the synthetic bodies — the pond tile and
 * the database tables, which have shapes of their own. Ties (one
 * commit that edited several files) break by path, so the order never
 * depends on the order the payload happened to list them in.
 */
export function gridFolders(
  nodes: readonly TerrainNode[],
  lastEdits: ReadonlyMap<string, number | null>,
  options: { skipRepos?: ReadonlySet<string>; skipIds?: ReadonlySet<string> } = {},
): GridPins[] {
  const skipRepos = options.skipRepos ?? GRID_SKIP_REPOS;
  const byFolder = new Map<string, TerrainNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.file || node.parentId === null) continue;
    if (node.file.days || node.file.table) continue;
    if (skipRepos.has(node.repoId) || options.skipIds?.has(node.id)) continue;
    const list = byFolder.get(node.parentId);
    if (list) list.push(node);
    else byFolder.set(node.parentId, [node]);
  }
  const editedAt = (node: TerrainNode) => lastEdits.get(node.id) ?? Infinity;
  return [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folderId, files]) => ({
      folderId,
      ids: files
        .sort((a, b) => editedAt(a) - editedAt(b) || (a.path ?? a.id).localeCompare(b.path ?? b.id))
        .map((node) => node.id),
    }));
}
