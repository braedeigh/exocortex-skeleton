import { describe, expect, it } from 'vitest';
import type { TerrainFile } from './api';
import { fileLastRun, filesGlowingByRun } from './runGlow';
import type { TerrainNode } from './terrainGraph';

/**
 * runGlow.test.ts — the Active bar's rule (runGlow.ts): what counts as a
 * file's last run, and which dots light up for a given window.
 *
 * The distinction these tests are really guarding is edits vs runs. The rule
 * used to mean "edited OR run", and a regression back to that would be
 * invisible on screen most of the time — a busy file is usually both.
 */

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const NOW = 1_000 * DAY;

function fileNode(id: string, file: Partial<TerrainFile>): TerrainNode {
  return {
    id,
    kind: 'file',
    label: id,
    parentId: null,
    depth: 1,
    repoId: 'skeleton',
    path: id,
    heat: 0,
    file: { path: id, touches: [], sessions: [], ...file },
  };
}

describe('fileLastRun', () => {
  it('takes the newest run, however many are on record', () => {
    const file = { path: 'a.py', touches: [], sessions: [], ran: [NOW - 3 * DAY, NOW - 10 * MINUTE, NOW - DAY] };
    expect(fileLastRun(file)).toBe(NOW - 10 * MINUTE);
  });

  it('is null for a file that has never run', () => {
    expect(fileLastRun({ path: 'a.py', touches: [], sessions: [] })).toBeNull();
  });

  it('is null for an empty run list, not zero', () => {
    // Math.max() of nothing is -Infinity, which would read as "ran long ago"
    // rather than "never ran" and would quietly make every such file eligible.
    expect(fileLastRun({ path: 'a.py', touches: [], sessions: [], ran: [] })).toBeNull();
  });
});

describe('filesGlowingByRun', () => {
  const justRan = fileNode('hot.py', { ran: [NOW - 10 * MINUTE] });
  const ranYesterday = fileNode('warm.py', { ran: [NOW - 20 * HOUR] });
  const ranLastWeek = fileNode('cold.py', { ran: [NOW - 6 * DAY] });
  const editedNeverRan = fileNode('fresh.tsx', { touches: [NOW - 5 * MINUTE] });
  const neverAnything = fileNode('untouched.md', {});
  const hub: TerrainNode = {
    id: 'routes', kind: 'dir', label: 'routes', parentId: null, depth: 1, repoId: 'skeleton', heat: 0,
  };
  const nodes = [justRan, ranYesterday, ranLastWeek, editedNeverRan, neverAnything, hub];

  it('lights only what ran inside the window', () => {
    expect([...filesGlowingByRun(nodes, HOUR, NOW)]).toEqual(['hot.py']);
  });

  it('widens with the window', () => {
    expect([...filesGlowingByRun(nodes, DAY, NOW)].sort()).toEqual(['hot.py', 'warm.py']);
    expect([...filesGlowingByRun(nodes, 7 * DAY, NOW)].sort()).toEqual(['cold.py', 'hot.py', 'warm.py']);
  });

  it('does NOT light a file that was just edited but never ran', () => {
    // The whole edits-vs-runs split, asserted directly: this file is the
    // freshest thing on the map by edit time and still must not glow.
    expect(filesGlowingByRun(nodes, 7 * DAY, NOW).has('fresh.tsx')).toBe(false);
  });

  it('leaves files with no record of anything dark', () => {
    expect(filesGlowingByRun(nodes, 7 * DAY, NOW).has('untouched.md')).toBe(false);
  });

  it('never lights anything that is not a file', () => {
    for (const id of filesGlowingByRun(nodes, 7 * DAY, NOW)) {
      expect(id).not.toBe('routes');
    }
  });

  it('skips the pond tile and table nodes, which have no runs to be judged by', () => {
    const pond = fileNode('pond', { days: [{ day: '2026-09-20', touches: [NOW] }], ran: [NOW] });
    const table = fileNode('exo.db:todos', { table: { name: 'todos' } as TerrainFile['table'], ran: [NOW] });
    expect(filesGlowingByRun([pond, table], HOUR, NOW).size).toBe(0);
  });

  it('lights nothing at all when nothing has run', () => {
    expect(filesGlowingByRun([editedNeverRan, neverAnything], 7 * DAY, NOW).size).toBe(0);
  });
});
