import { describe, expect, it } from 'vitest';
import type { TerrainData, TerrainFile } from './api';
import {
  GRID_PITCH,
  GRID_RING_GAP,
  fileLastEdits,
  gridArrangement,
  gridFolders,
  rectExit,
} from './fileGrids';
import { buildTerrainGraph } from './terrainGraph';
import { fileRadius } from './terrainCanvas';

/**
 * fileGrids.test.ts — each folder's code files as a grid of dots, the one
 * edited longest ago top-left, the one edited most recently bottom-right
 * (fileGrids.ts).
 *
 * Run the way the Files room runs it: a payload goes through
 * buildTerrainGraph, the grids are read off the graph, and positions come out
 * of gridArrangement. Pinned here: the reading order (down each column, then
 * the next column to the right, in a square); that order is by LAST EDIT —
 * a commit or an agent's write — so editing an old file sends it to the end;
 * and that the biggest dot with its ring still fits its cell.
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
  const grid = gridFolders(graph.nodes, fileLastEdits(data)).find((g) => g.folderId === folder)!;
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
  // Thirty files, each last edited a day after the one before, listed newest
  // first — the opposite of the order the grid has to put them in.
  const files = Array.from({ length: 30 }, (_, i) =>
    file(`src/f${String(i).padStart(2, '0')}.ts`, [NOW - (60 - i) * DAY, NOW - 200 * DAY]),
  ).reverse();

  it('reads down each column, then the next column right, oldest edit top-left to newest bottom-right', () => {
    const cells = placed(payload(files));
    // Thirty files need a square six tall: five full columns.
    for (let i = 0; i < 30; i += 1) {
      expect(cells.get(`src/f${String(i).padStart(2, '0')}.ts`)).toEqual({ col: Math.floor(i / 6), row: i % 6 });
    }
    expect(cells.get('src/f00.ts')).toEqual({ col: 0, row: 0 });
    expect(cells.get('src/f29.ts')).toEqual({ col: 4, row: 5 });
  });

  it('stays a square as the folder grows', () => {
    for (const count of [1, 2, 4, 5, 9, 10, 16, 17, 60, 100]) {
      const cells = [...placed(payload(files.concat(files, files, files).slice(0, count).map((f, i) => ({ ...f, path: `src/g${i}.ts` })))).values()];
      const side = Math.ceil(Math.sqrt(count));
      expect(Math.max(...cells.map((c) => c.row)) + 1).toBe(Math.min(side, count));
      expect(Math.max(...cells.map((c) => c.col)) + 1).toBe(Math.ceil(count / side));
    }
  });

  it('orders by when a file was last edited, by a commit or by an agent, not when it was made', () => {
    // f00 was edited longest ago — until a commit an hour ago; f01 until an
    // agent wrote to it ten minutes ago (not yet committed); an agent only
    // READING f02 changes nothing; a file with no history at all is newest.
    const session = (last: number, writes: number) => ({
      id: 's', title: 's', writes, reads: 1, last: new Date(last * 1000).toISOString(),
    });
    const edited = files.map((f) =>
      f.path === 'src/f00.ts'
        ? { ...f, touches: [NOW - 3600, ...f.touches] }
        : f.path === 'src/f01.ts'
          ? { ...f, sessions: [session(NOW - 600, 2)] }
          : f.path === 'src/f02.ts'
            ? { ...f, sessions: [session(NOW - 60, 0)] }
            : f,
    );
    const data = payload([...edited, file('src/fresh.ts', [])]);
    const graph = buildTerrainGraph(data, 'week', NOW);
    const order = gridFolders(graph.nodes, fileLastEdits(data))[0].ids.map((id) => id.split(':file:')[1]);
    expect(order[0]).toBe('src/f02.ts');
    expect(order.slice(-3)).toEqual(['src/f00.ts', 'src/f01.ts', 'src/fresh.ts']);
  });

  it('leaves the vault, coil dots, the pond tile and tables out of the grids', () => {
    const vault = payload([file('notes/a.md', [NOW]), file('notes/b.md', [NOW])], 'vault');
    const graph = buildTerrainGraph(vault, 'week', NOW);
    expect(gridFolders(graph.nodes, fileLastEdits(vault))).toEqual([]);
    const code = payload([file('src/a.ts', [NOW]), file('src/b.ts', [NOW])]);
    const codeGraph = buildTerrainGraph(code, 'week', NOW);
    const grids = gridFolders(codeGraph.nodes, fileLastEdits(code), { skipIds: new Set(['skeleton:file:src/a.ts']) });
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
