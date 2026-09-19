import { describe, expect, it } from 'vitest';
import type { TerrainFile } from './api';
import {
  effectiveActivity,
  fileLastActive,
  filesHiddenByActivity,
  type ActivityFilter,
} from './activityFilter';
import type { TerrainNode } from './terrainGraph';

/**
 * activityFilter.test.ts — the All / Recent / Old rule (activityFilter.ts):
 * what counts as a file's last activity, and which dots each setting hides.
 */

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

const fresh = fileNode('fresh.py', { touches: [NOW - 2 * DAY] });
const stale = fileNode('stale.py', { touches: [NOW - 90 * DAY] });
const untouched = fileNode('untouched.py', {});
const hub: TerrainNode = { id: 'routes', kind: 'dir', label: 'routes', parentId: null, depth: 1, repoId: 'skeleton', heat: 0 };

describe('fileLastActive', () => {
  it('takes a run as activity, even when the last edit is old', () => {
    const file = { path: 'a.py', touches: [NOW - 90 * DAY], sessions: [], ran: [NOW - 3 * DAY, NOW - DAY] };
    expect(fileLastActive(file)).toBe(NOW - DAY);
  });

  it('takes an agent write as activity', () => {
    const last = new Date((NOW - DAY) * 1000).toISOString();
    const file = { path: 'a.py', touches: [], sessions: [{ id: 's', last } as TerrainFile['sessions'][number]] };
    expect(fileLastActive(file)).toBe(NOW - DAY);
  });

  it('is null when nothing is on record', () => {
    expect(fileLastActive({ path: 'a.py', touches: [], sessions: [] })).toBeNull();
  });
});

describe('filesHiddenByActivity', () => {
  const nodes = [fresh, stale, untouched, hub];

  it('hides nothing under All', () => {
    expect(filesHiddenByActivity(nodes, 'all', 7 * DAY, NOW).size).toBe(0);
  });

  it('Recent hides what fell outside the window, including never-touched files', () => {
    expect([...filesHiddenByActivity(nodes, 'recent', 7 * DAY, NOW)].sort()).toEqual(['stale.py', 'untouched.py']);
  });

  it('Old hides exactly what Recent shows, so the two are halves of one map', () => {
    expect([...filesHiddenByActivity(nodes, 'old', 7 * DAY, NOW)]).toEqual(['fresh.py']);
  });

  it('follows the window: widen it and a stale file becomes recent', () => {
    expect(filesHiddenByActivity(nodes, 'recent', 120 * DAY, NOW).has('stale.py')).toBe(false);
  });

  it('never hides a folder', () => {
    expect(filesHiddenByActivity(nodes, 'old', 7 * DAY, NOW).has('routes')).toBe(false);
  });

  it('never hides the pond tile', () => {
    const pond = fileNode('pond', { days: [{ day: '2026-09-01', touches: [] }] });
    expect(filesHiddenByActivity([pond], 'recent', 7 * DAY, NOW).size).toBe(0);
  });
});

describe('effectiveActivity — the switch belongs to the Types view', () => {
  it('means nothing on the heat map: every file is drawn whatever she set', () => {
    expect(effectiveActivity('recent', false)).toBe('all');
    expect(effectiveActivity('old', false)).toBe('all');
  });

  it('bites under Types, which is the only place age cannot be read off colour', () => {
    expect(effectiveActivity('recent', true)).toBe('recent');
    expect(effectiveActivity('old', true)).toBe('old');
  });

  it('keeps her choice while it is inert, so turning Types back on restores it', () => {
    const chosen: ActivityFilter = 'old';
    expect(effectiveActivity(chosen, false)).toBe('all');
    expect(effectiveActivity(chosen, true)).toBe('old');
  });
});
