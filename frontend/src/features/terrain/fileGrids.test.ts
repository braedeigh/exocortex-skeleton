import { describe, expect, it } from 'vitest';
import type { TerrainData, TerrainFile } from './api';
import {
  GRID_PITCH,
  GRID_RING_GAP,
  fileBirths,
  gridArrangement,
  gridFolders,
  rectExit,
} from './fileGrids';
import { buildTerrainGraph } from './terrainGraph';
import { fileRadius } from './terrainCanvas';

/**
 * fileGrids.test.ts — each folder's code files as a grid of dots, oldest at
 * the top-left, newest toward the bottom-right (fileGrids.ts).
 *
 * Run the way the Files room runs it: a payload goes through
 * buildTerrainGraph, the grids are read off the graph, and positions come out
 * of gridArrangement. Pinned here: the corner rule (oldest top-left, every
 * row and column running oldest → newest); that a new file only ever ADDS a
 * dot — nothing already on the map moves; that order is by birth, so an
 * agent editing an old file doesn't drag it to the end; and that the biggest
 * dot with its ring still fits its cell.
 */

const DAY = 86400;
const NOW = 1_790_000_000;

function file(path: string, touches: number[], bytes = 2000): TerrainFile {
  return { path, touches: [...touches].sort((a, b) => b - a), sessions: [], bytes };
}

function payload(files: TerrainFile[], repo = 'skeleton'): TerrainData {
  return {
    generated_at: '',
    window_days: null,
    file_cap: null,
    repos: [{ id: repo, name: repo, root: '/', files, files_total: files.length }],
  };
}

/** Where each file in `folder` lands, as {path: {col,row}} in pitches. */
function placed(data: TerrainData, folder = 'skeleton:dir:src') {
  const graph = buildTerrainGraph(data, 'week', NOW);
  const grid = gridFolders(graph.nodes, fileBirths(data)).find((g) => g.folderId === folder)!;
  const { spots, origin } = gridArrangement(grid.ids.length);
  return new Map(
    grid.ids.map((id, i) => [
      id.split(':file:')[1],
      {
        col: Math.round((spots[i].x - origin.x) / GRID_PITCH),
        row: Math.round((spots[i].y - origin.y) / GRID_PITCH),
      },
    ]),
  );
}

describe('a folder grid', () => {
  // Thirty files, born a day apart, listed newest first — the opposite of
  // the order the grid has to put them in.
  const files = Array.from({ length: 30 }, (_, i) =>
    file(`src/f${String(i).padStart(2, '0')}.ts`, [NOW - (60 - i) * DAY]),
  ).reverse();

  it('puts the oldest file top-left and runs every row and column oldest to newest', () => {
    const cells = placed(payload(files));
    expect(cells.get('src/f00.ts')).toEqual({ col: 0, row: 0 });
    const byCell = new Map([...cells].map(([path, c]) => [`${c.col},${c.row}`, Number(path.slice(5, 7))]));
    for (const [key, age] of byCell) {
      const [col, row] = key.split(',').map(Number);
      const right = byCell.get(`${col + 1},${row}`);
      const below = byCell.get(`${col},${row + 1}`);
      if (right !== undefined) expect(right).toBeGreaterThan(age);
      if (below !== undefined) expect(below).toBeGreaterThan(age);
    }
  });

  it('adds a new file as one more dot without moving any file already there', () => {
    const before = placed(payload(files));
    for (let extra = 1; extra <= 12; extra += 1) {
      const born = Array.from({ length: extra }, (_, i) => file(`src/new${i}.ts`, [NOW - DAY + i * 60]));
      const after = placed(payload([...files, ...born]));
      for (const [path, cell] of before) expect(after.get(path)).toEqual(cell);
    }
  });

  it('orders by when a file was born, not when it was last edited', () => {
    // f00 is the oldest file, edited again an hour ago; an uncommitted file
    // (no history at all) is the newest thing in the folder.
    const edited = files.map((f) => (f.path === 'src/f00.ts' ? { ...f, touches: [NOW - 3600, ...f.touches] } : f));
    const cells = placed(payload([...edited, file('src/fresh.ts', [])]));
    expect(cells.get('src/f00.ts')).toEqual({ col: 0, row: 0 });
    const graph = buildTerrainGraph(payload([...edited, file('src/fresh.ts', [])]), 'week', NOW);
    const grid = gridFolders(graph.nodes, fileBirths(payload([...edited, file('src/fresh.ts', [])])))[0];
    expect(grid.ids[grid.ids.length - 1]).toBe('skeleton:file:src/fresh.ts');
  });

  it('leaves the vault, coil dots, the pond tile and tables out of the grids', () => {
    const vault = payload([file('notes/a.md', [NOW]), file('notes/b.md', [NOW])], 'vault');
    const graph = buildTerrainGraph(vault, 'week', NOW);
    expect(gridFolders(graph.nodes, fileBirths(vault))).toEqual([]);
    const code = payload([file('src/a.ts', [NOW]), file('src/b.ts', [NOW])]);
    const codeGraph = buildTerrainGraph(code, 'week', NOW);
    const grids = gridFolders(codeGraph.nodes, fileBirths(code), { skipIds: new Set(['skeleton:file:src/a.ts']) });
    expect(grids).toEqual([{ folderId: 'skeleton:dir:src', ids: ['skeleton:file:src/b.ts'] }]);
  });

  it('fits the biggest dot, ringed, inside its cell and inside the frame', () => {
    const biggest = fileRadius(1e9) + GRID_RING_GAP;
    expect(biggest * 2).toBeLessThanOrEqual(GRID_PITCH);
    const { spots, frame } = gridArrangement(50);
    for (const s of spots) {
      expect(s.x - biggest).toBeGreaterThanOrEqual(frame.left);
      expect(s.x + biggest).toBeLessThanOrEqual(frame.right);
      expect(s.y - biggest).toBeGreaterThanOrEqual(frame.top);
      expect(s.y + biggest).toBeLessThanOrEqual(frame.bottom);
    }
  });
});

describe('a rope between two grids', () => {
  it('starts at the edge of the frame instead of running through the dots', () => {
    const rect = { left: -50, top: -40, right: 50, bottom: 40 };
    expect(rectExit({ x: 0, y: 0 }, { x: 200, y: 0 }, rect)).toEqual({ x: 50, y: 0 });
    expect(rectExit({ x: 0, y: 0 }, { x: 10, y: 10 }, rect)).toEqual({ x: 10, y: 10 });
  });
});
