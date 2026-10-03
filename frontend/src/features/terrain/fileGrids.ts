/**
 * fileGrids.ts — a folder's code files laid out as a grid of dots, oldest at
 * the top-left and newest toward the bottom-right.
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
 * ORDER IS BIRTH, NOT LAST EDIT. A file's place in its grid is when it was
 * first committed — the oldest touch in its git history, which the payload
 * carries whole (codestore.py `touches`). Last-edit order would reshuffle the
 * grid every time an agent saved a file; the dot's colour already says how
 * recently it was touched, so the position can say something that never
 * changes. A file git hasn't seen yet is the newest thing there is and goes
 * last.
 *
 * THE FILL IS IN SQUARE SHELLS, so a new file never moves an old one. Cells
 * 0–3 fill a 2×2; cells 4–8 add a column down the right and then a row along
 * the bottom, making a 3×3; and so on. A plain left-to-right grid can't do
 * that: when it grows a column, every row reflows and every dot moves. In
 * shell order every ROW still reads oldest→newest left to right and every
 * COLUMN oldest→newest top to bottom — the oldest file is the top-left dot,
 * and the newest ones are always along the bottom and right edges.
 *
 * SIZE IS FILE SIZE. Each dot is fileRadius(bytes) (terrainCanvas.ts, a log
 * scale), and the grid's pitch is fixed to fit the BIGGEST possible dot with
 * its touch ring, so every grid on the map has the same spacing and a big
 * file arriving never respaces a grid.
 *
 * Tested in fileGrids.test.ts.
 *
 * Prompt that produced it: "I want my terrain files instead stored in grids.
 * With newest on the bottom right and oldest on the top left. I want them to
 * be dot grids and scaled by size = size of file. I want all code/ app files
 * organized this way on the terrain."
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

/**
 * Which cell the index-th oldest file sits in: the shell fill described above.
 *
 * Shell `k` is everything that turns a k×k square into a (k+1)×(k+1) one: the
 * new right-hand column first, top to bottom, then the new bottom row, left
 * to right, ending in the bottom-right corner.
 */
export function gridCell(index: number): { col: number; row: number } {
  const shell = Math.floor(Math.sqrt(index));
  const along = index - shell * shell;
  if (along < shell) return { col: shell, row: along };
  return { col: along - shell, row: shell };
}

export interface GridArrangement {
  /** One spot per dot, oldest first, relative to the frame's CENTRE — the
   * point the folder node sits on. */
  spots: { x: number; y: number }[];
  /** The frame around the dots, relative to the same centre. */
  frame: GridRect;
  /** Where cell 0 sits relative to the centre. When a grid grows, the canvas
   * moves the folder by the change in this, so the dots already there stay
   * put on the map. */
  origin: { x: number; y: number };
}

/** Lay `count` dots out in shell order, and the frame that holds them. */
export function gridArrangement(count: number, pitch: number = GRID_PITCH): GridArrangement {
  // Work in cell space first (cell 0 at 0,0), measuring how far the grid
  // reaches, then shift everything so the frame's centre is the origin.
  const cells = Array.from({ length: count }, (_, i) => gridCell(i));
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
 * When a file was born, in unix seconds: its first commit, or — for a file
 * git hasn't seen — the earliest stamp of an agent that CREATED it. Null when
 * neither is known; the grid treats that as newest.
 *
 * Must be read off the payload BEFORE the date dial strips touches
 * (filterTerrainData), or narrowing the dates would re-order every grid.
 */
export function fileBirth(file: TerrainFile): number | null {
  let born = Infinity;
  for (const ts of file.touches) if (ts < born) born = ts;
  if (Number.isFinite(born)) return born;
  for (const s of file.sessions) {
    if ((s.creates ?? 0) <= 0 || typeof s.last !== 'string') continue;
    const ms = Date.parse(s.last);
    if (Number.isFinite(ms)) born = Math.min(born, ms / 1000);
  }
  return Number.isFinite(born) ? born : null;
}

/** Every file's birth in a payload, by the node id the graph gives it. */
export function fileBirths(data: TerrainData): Map<string, number | null> {
  const births = new Map<string, number | null>();
  for (const repo of data.repos) {
    for (const file of repo.files) births.set(`${repo.id}:file:${file.path}`, fileBirth(file));
  }
  return births;
}

/** One grid as the canvas asks for it: the folder at its centre, and its
 * files oldest first. */
export interface GridPins {
  folderId: string;
  ids: string[];
}

/**
 * Group the graph's code files into one grid per folder, each oldest first.
 *
 * Left out: files in GRID_SKIP_REPOS, anything in `skipIds` (the coils' dots,
 * which have their own spiral), and the synthetic bodies — the pond tile and
 * the database tables, which have shapes of their own. Ties on birth (one
 * commit that added several files) break by path, so the order never
 * depends on the order the payload happened to list them in.
 */
export function gridFolders(
  nodes: readonly TerrainNode[],
  births: ReadonlyMap<string, number | null>,
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
  const bornAt = (node: TerrainNode) => births.get(node.id) ?? Infinity;
  return [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folderId, files]) => ({
      folderId,
      ids: files
        .sort((a, b) => bornAt(a) - bornAt(b) || (a.path ?? a.id).localeCompare(b.path ?? b.id))
        .map((node) => node.id),
    }));
}
