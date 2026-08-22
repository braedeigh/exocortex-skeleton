import { describe, expect, it } from 'vitest';
import {
  agentTouchRings,
  buildTerrainGraph,
  formatAge,
  heatKeyTicks,
  heatTrackStops,
  computeFileHeat,
  fileCreatedWithin,
  CREATED_FRESH_WINDOW_SECONDS,
  fileLastTouch,
  normalizeHeat,
  relativeAge,
  sessionFileTouch,
  sessionFootprint,
  sessionLastSeconds,
  sessionFootprintByRecency,
  sessionTouchRings,
  topHeatFiles,
  LENS_HALF_LIFE_SECONDS,
  changedFileIds,
  breathHalfLife,
  bucketHeat,
  halfLifeSeconds,
  filterTerrainData,
  terrainEarliestTouch,
  terrainFileLoaded,
  terrainFileTotal,
  type TerrainNode,
} from './terrainGraph';
import type { TerrainData, TerrainFile, TerrainLiveSession, TerrainRepo } from './api';

const NOW = 1_700_000_000; // fixed unix-seconds "now" for deterministic tests

function file(path: string, touches: number[] = [], sessions: TerrainFile['sessions'] = []): TerrainFile {
  return { path, touches, sessions };
}

describe('computeFileHeat', () => {
  it('scores a touch right now at 1', () => {
    expect(computeFileHeat(file('a.py', [NOW]), 'week', NOW)).toBeCloseTo(1, 6);
  });

  it('scores a touch exactly one half-life old at 0.5', () => {
    const halfLife = LENS_HALF_LIFE_SECONDS.week;
    expect(computeFileHeat(file('a.py', [NOW - halfLife]), 'week', NOW)).toBeCloseTo(0.5, 6);
  });

  it('sums decayed contributions from multiple touches', () => {
    const halfLife = LENS_HALF_LIFE_SECONDS.day;
    const heat = computeFileHeat(file('a.py', [NOW, NOW - halfLife]), 'day', NOW);
    expect(heat).toBeCloseTo(1.5, 6);
  });

  it('counts a session\'s last write as an extra touch', () => {
    const withSession = computeFileHeat(
      file('a.py', [], [{ id: 's1', title: 'x', writes: 1, reads: 0, last: NOW }]),
      'week',
      NOW,
    );
    expect(withSession).toBeCloseTo(1, 6);
  });

  it('a shorter lens makes the same age colder (faster decay)', () => {
    const age = LENS_HALF_LIFE_SECONDS.day; // one day old
    const dayHeat = computeFileHeat(file('a.py', [NOW - age]), 'day', NOW);
    const monthHeat = computeFileHeat(file('a.py', [NOW - age]), 'month', NOW);
    expect(dayHeat).toBeLessThan(monthHeat);
  });
});

describe('normalizeHeat', () => {
  it('maps zero heat to zero', () => {
    expect(normalizeHeat(0)).toBe(0);
  });

  it('is monotone increasing and saturates toward 1', () => {
    const low = normalizeHeat(0.5);
    const mid = normalizeHeat(1);
    const high = normalizeHeat(5);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBeLessThan(1);
    expect(high).toBeGreaterThan(0.95);
  });
});

/** Repos as the tests write them — files_total defaults to "no cut applied",
 * which is what every graph-shape test wants; the dial tests set it. */
type RepoInput = Omit<TerrainRepo, 'files_total'> & { files_total?: number };

function makeData(repos: RepoInput[]): TerrainData {
  return {
    generated_at: new Date(NOW * 1000).toISOString(),
    window_days: 90,
    file_cap: null,
    repos: repos.map((r) => ({ ...r, files_total: r.files_total ?? r.files.length })),
  };
}

describe('buildTerrainGraph', () => {
  it('emits one repo hub per repo, each labeled by name', () => {
    const data = makeData([
      { id: 'skeleton', name: 'App code', root: '/app', files: [file('server.py', [NOW])] },
      { id: 'vault', name: 'Vault', root: '/vault', files: [file('notes.md', [NOW])] },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    const hubs = g.nodes.filter((n) => n.kind === 'repo');
    expect(hubs.map((h) => h.label).sort()).toEqual(['App code', 'Vault']);
    expect(hubs.every((h) => h.parentId === null)).toBe(true);
  });

  it('collapses a single-child directory chain into one labeled hub', () => {
    const data = makeData([
      { id: 'skeleton', name: 'App code', root: '/app', files: [file('routes/kitchen/utils.py', [NOW])] },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    const dirs = g.nodes.filter((n) => n.kind === 'dir');
    // routes/ has exactly one child (kitchen/) and no files of its own, and
    // kitchen/ has exactly one file (no sub-dirs) — the chain collapses to
    // a single "routes/kitchen" hub sitting directly under the repo root.
    expect(dirs).toHaveLength(1);
    expect(dirs[0].label).toBe('routes/kitchen');
    expect(dirs[0].parentId).toBe('repo:skeleton');
  });

  it('does not collapse a directory that branches into multiple children', () => {
    const data = makeData([
      {
        id: 'skeleton',
        name: 'App code',
        root: '/app',
        files: [file('routes/a.py', [NOW]), file('routes/kitchen/b.py', [NOW])],
      },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    const dirLabels = g.nodes.filter((n) => n.kind === 'dir').map((n) => n.label).sort();
    // routes/ holds a file directly, so it can't merge into its child —
    // "routes" stays its own hub, with "kitchen" a distinct child hub
    // (labels are relative to their rendered parent, not full paths).
    expect(dirLabels).toEqual(['kitchen', 'routes']);
  });

  it('every file node carries the full repo-relative path', () => {
    const data = makeData([
      { id: 'skeleton', name: 'App code', root: '/app', files: [file('a/b/c.py', [NOW])] },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    const leaf = g.nodes.find((n) => n.kind === 'file');
    expect(leaf?.path).toBe('a/b/c.py');
    expect(leaf?.label).toBe('c.py');
  });

  it('edges connect every node to its rendered parent', () => {
    const data = makeData([
      { id: 'skeleton', name: 'App code', root: '/app', files: [file('routes/kitchen/utils.py', [NOW])] },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    for (const node of g.nodes) {
      if (node.parentId === null) continue;
      expect(g.edges.some((e) => e.source === node.parentId && e.target === node.id)).toBe(true);
    }
  });

  it('directory heat is the decayed max of its children, hotter file wins', () => {
    const data = makeData([
      {
        id: 'skeleton',
        name: 'App code',
        root: '/app',
        files: [file('routes/hot.py', [NOW]), file('routes/cold.py', [NOW - LENS_HALF_LIFE_SECONDS.week * 5])],
      },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    const dir = g.nodes.find((n) => n.kind === 'dir' && n.label === 'routes') as TerrainNode;
    const hot = g.nodes.find((n) => n.path === 'routes/hot.py') as TerrainNode;
    expect(dir.heat).toBeCloseTo(hot.heat * 0.92, 6);
  });

  it('repo hub heat rolls up from its hottest descendant', () => {
    const data = makeData([
      { id: 'skeleton', name: 'App code', root: '/app', files: [file('deep/nested/hot.py', [NOW])] },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    const repo = g.nodes.find((n) => n.kind === 'repo') as TerrainNode;
    expect(repo.heat).toBeGreaterThan(0);
  });
});

describe('topHeatFiles', () => {
  it('returns the N hottest file nodes, hottest first, dirs excluded', () => {
    const nodes: TerrainNode[] = [
      { id: 'd', kind: 'dir', label: 'd', parentId: null, depth: 1, repoId: 'r', heat: 99 },
      { id: 'a', kind: 'file', label: 'a', parentId: null, depth: 1, repoId: 'r', heat: 0.2 },
      { id: 'b', kind: 'file', label: 'b', parentId: null, depth: 1, repoId: 'r', heat: 0.9 },
      { id: 'c', kind: 'file', label: 'c', parentId: null, depth: 1, repoId: 'r', heat: 0.5 },
    ];
    expect(topHeatFiles(nodes, 2).map((n) => n.id)).toEqual(['b', 'c']);
  });
});

describe('relativeAge', () => {
  const nowMs = NOW * 1000;
  it('renders minutes, hours and days compactly, no "ago"', () => {
    expect(relativeAge(NOW - 5 * 60, nowMs)).toBe('5m');
    expect(relativeAge(NOW - 3 * 3600, nowMs)).toBe('3h');
    expect(relativeAge(NOW - 2 * 86400, nowMs)).toBe('2d');
  });

  it('collapses anything under a minute to "now"', () => {
    expect(relativeAge(NOW - 10, nowMs)).toBe('now');
  });
});

describe('fileLastTouch', () => {
  it('is the max of raw touches and every session\'s last write', () => {
    const f = file('a.py', [NOW - 1000], [{ id: 's1', title: 'x', writes: 1, reads: 0, last: NOW - 10 }]);
    expect(fileLastTouch(f)).toBe(NOW - 10);
  });

  it('is null when there is nothing to touch from', () => {
    expect(fileLastTouch(file('a.py'))).toBeNull();
  });
});

describe('sessionFootprint', () => {
  it('collects every file node a session touched, ignoring directories', () => {
    const nodes: TerrainNode[] = [
      {
        id: 'f1',
        kind: 'file',
        label: 'f1',
        parentId: null,
        depth: 1,
        repoId: 'r',
        heat: 1,
        file: file('f1.py', [], [{ id: 's1', title: 'x', writes: 1, reads: 0, last: NOW }]),
      },
      {
        id: 'f2',
        kind: 'file',
        label: 'f2',
        parentId: null,
        depth: 1,
        repoId: 'r',
        heat: 1,
        file: file('f2.py', [], [{ id: 's2', title: 'y', writes: 1, reads: 0, last: NOW }]),
      },
      { id: 'd1', kind: 'dir', label: 'd1', parentId: null, depth: 1, repoId: 'r', heat: 1 },
    ];
    expect(sessionFootprint(nodes, 's1')).toEqual(new Set(['f1']));
  });
});

describe('buildSessionOrbs (via buildTerrainGraph)', () => {
  const liveSessions: TerrainLiveSession[] = [
    { id: 's1', title: 'Fix the kitchen', bot: 'spark', running: true, last: new Date((NOW - 30) * 1000).toISOString() },
    { id: 's-elsewhere', title: 'No footprint here', bot: 'keeper', running: false, last: null },
  ];

  function dataWithSessions() {
    return {
      ...makeData([
        {
          id: 'skeleton',
          name: 'App code',
          root: '/app',
          files: [
            file('a.py', [NOW], [{ id: 's1', title: 'Fix the kitchen', writes: 3, reads: 1, last: NOW - 60 }]),
            file('b.py', [NOW], [{ id: 's1', title: 'Fix the kitchen', writes: 1, reads: 0, last: NOW - 120 }]),
            file('c.py', [NOW], [{ id: 's2', title: 'Old exploration', writes: 0, reads: 2, last: NOW - 9000 }]),
          ],
        },
      ]),
      sessions: liveSessions,
    };
  }

  it('creates one orb per session with a nonempty footprint (inverted from files)', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW);
    const orbs = g.nodes.filter((n) => n.kind === 'session');
    expect(orbs.map((o) => o.session?.id).sort()).toEqual(['s1', 's2']);
  });

  it('does NOT create an orb for a live session that touched no files', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW);
    expect(g.nodes.some((n) => n.kind === 'session' && n.session?.id === 's-elsewhere')).toBe(false);
  });

  it('takes title/bot/running/last from the top-level sessions array when present', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW);
    const orb = g.nodes.find((n) => n.kind === 'session' && n.session?.id === 's1');
    expect(orb?.session?.bot).toBe('spark');
    expect(orb?.session?.running).toBe(true);
    expect(orb?.session?.last).toBeCloseTo(NOW - 30, 0);
    expect(orb?.label).toBe('Fix the kitchen');
  });

  it('falls back to file-level title/last (not running, no bot) for sessions absent from the array', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW);
    const orb = g.nodes.find((n) => n.kind === 'session' && n.session?.id === 's2');
    expect(orb?.session?.bot).toBeUndefined();
    expect(orb?.session?.running).toBe(false);
    expect(orb?.session?.last).toBe(NOW - 9000);
    expect(orb?.label).toBe('Old exploration');
  });

  it("tethers each orb to every footprint file with kind:'session' edges", () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW);
    const tethers = g.edges.filter((e) => e.kind === 'session' && e.source === 'session:s1');
    expect(tethers.map((e) => e.target).sort()).toEqual(['skeleton:file:a.py', 'skeleton:file:b.py']);
  });

  it('orbs carry zero heat (identity, never the ember ramp) and empty repoId', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW);
    const orbs = g.nodes.filter((n) => n.kind === 'session');
    expect(orbs.every((o) => o.heat === 0 && o.repoId === '')).toBe(true);
  });

  it('builds no orbs when the payload has no sessions array (backend not landed)', () => {
    const g = buildTerrainGraph(
      makeData([{ id: 'skeleton', name: 'App code', root: '/app', files: [file('a.py', [NOW])] }]),
      'week',
      NOW,
    );
    expect(g.nodes.some((n) => n.kind === 'session')).toBe(false);
  });

  it('restricts orbs to opts.orbSessionIds when given (the backdrop active set)', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW, { orbSessionIds: new Set(['s1']) });
    const orbs = g.nodes.filter((n) => n.kind === 'session');
    expect(orbs.map((o) => o.session?.id)).toEqual(['s1']);
  });

  it('drops every orb when the active set is empty (nothing live, no focus)', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW, { orbSessionIds: new Set() });
    expect(g.nodes.some((n) => n.kind === 'session')).toBe(false);
  });

  it('emits every footprinted orb when orbSessionIds is omitted (the /terrain map)', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW, {});
    const orbs = g.nodes.filter((n) => n.kind === 'session');
    expect(orbs.map((o) => o.session?.id).sort()).toEqual(['s1', 's2']);
  });

  // opts.alwaysOrbIds — "any open agent shows on the map", even one that
  // hasn't touched a file yet and so never appears in the files[] inversion.
  it('gives a footprint-less session an orb when alwaysOrbIds names it', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW, {
      alwaysOrbIds: new Set(['s-elsewhere']),
    });
    const orb = g.nodes.find((n) => n.kind === 'session' && n.session?.id === 's-elsewhere');
    expect(orb?.label).toBe('No footprint here');
    expect(orb?.session?.files).toBe(0);
  });

  it('gives a footprint-less orb no tethers — it has no territory to be parked in', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW, {
      alwaysOrbIds: new Set(['s-elsewhere']),
    });
    expect(g.edges.some((e) => e.source === 'session:s-elsewhere')).toBe(false);
  });

  it('never doubles an orb for a session that already has a footprint', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW, {
      alwaysOrbIds: new Set(['s1', 's-elsewhere']),
    });
    expect(g.nodes.filter((n) => n.kind === 'session' && n.session?.id === 's1')).toHaveLength(1);
  });

  // open/lane drive the agent bar's pool + section filters. They only exist on
  // the payload's top-level sessions array, so an orb known purely from file
  // attribution has to degrade rather than guess.
  it('carries open + lane through from the sessions array', () => {
    const data = dataWithSessions();
    data.sessions = [{ ...liveSessions[0], open: true, lane: 'personal' }];
    const g = buildTerrainGraph(data, 'week', NOW);
    const orb = g.nodes.find((n) => n.kind === 'session' && n.session?.id === 's1');
    expect(orb?.session?.open).toBe(true);
    expect(orb?.session?.lane).toBe('personal');
  });

  it('reads an orb the sessions array never mentions as closed, with no lane', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW);
    const orb = g.nodes.find((n) => n.kind === 'session' && n.session?.id === 's2');
    expect(orb?.session?.open).toBe(false);
    expect(orb?.session?.lane).toBe('');
  });

  it('skips an alwaysOrbIds session the payload has no identity for — no title, no orb', () => {
    const g = buildTerrainGraph(dataWithSessions(), 'week', NOW, {
      alwaysOrbIds: new Set(['s-unknown']),
    });
    expect(g.nodes.some((n) => n.kind === 'session' && n.session?.id === 's-unknown')).toBe(false);
  });
});

describe('fileCreatedWithin', () => {
  it('true when a session created the file and last touched it within the window', () => {
    const f = file('new.ts', [], [{ id: 's1', title: 'x', writes: 1, reads: 0, creates: 1, last: NOW - 3600 }]);
    expect(fileCreatedWithin(f, CREATED_FRESH_WINDOW_SECONDS, NOW)).toBe(true);
  });

  it('false when the creating touch is older than the window', () => {
    const f = file(
      'old.ts',
      [],
      [{ id: 's1', title: 'x', writes: 1, reads: 0, creates: 1, last: NOW - 2 * CREATED_FRESH_WINDOW_SECONDS }],
    );
    expect(fileCreatedWithin(f, CREATED_FRESH_WINDOW_SECONDS, NOW)).toBe(false);
  });

  it('false when the session only modified it (creates 0), however recent', () => {
    const f = file('mod.ts', [], [{ id: 's1', title: 'x', writes: 4, reads: 0, creates: 0, last: NOW - 60 }]);
    expect(fileCreatedWithin(f, CREATED_FRESH_WINDOW_SECONDS, NOW)).toBe(false);
  });
});

describe('changedFileIds', () => {
  it('flags a file whose newest touch advanced', () => {
    const prev = makeData([{ id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW - 100])] }]);
    const next = makeData([{ id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW, NOW - 100])] }]);
    expect(changedFileIds(prev, next)).toEqual(new Set(['r:file:a.py']));
  });

  it('flags a session-write advance even when raw touches are unchanged', () => {
    const prev = makeData([
      { id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW - 500], [{ id: 's', title: 't', writes: 1, reads: 0, last: NOW - 400 }])] },
    ]);
    const next = makeData([
      { id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW - 500], [{ id: 's', title: 't', writes: 2, reads: 0, last: NOW - 5 }])] },
    ]);
    expect(changedFileIds(prev, next)).toEqual(new Set(['r:file:a.py']));
  });

  it('flags files that are brand-new on the map', () => {
    const prev = makeData([{ id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW - 100])] }]);
    const next = makeData([{ id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW - 100]), file('new.py', [NOW])] }]);
    expect(changedFileIds(prev, next)).toEqual(new Set(['r:file:new.py']));
  });

  it('returns empty when nothing moved', () => {
    const d = makeData([{ id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW - 100])] }]);
    expect(changedFileIds(d, d).size).toBe(0);
  });
});

// --- the dials: date range + how many files ---------------------------------

const DAY = 86400;

describe('filterTerrainData — date range', () => {
  const data = makeData([
    {
      id: 'r',
      name: 'R',
      root: '/',
      files: [
        file('old.py', [NOW - 30 * DAY]),
        file('mid.py', [NOW - 10 * DAY]),
        file('new.py', [NOW - 1 * DAY]),
      ],
    },
  ]);

  it('keeps only files touched inside the range', () => {
    const out = filterTerrainData(data, { from: NOW - 14 * DAY, to: NOW, count: null }, NOW);
    expect(out.repos[0].files.map((f) => f.path)).toEqual(['mid.py', 'new.py']);
  });

  it('excludes files whose only touches are newer than the range end', () => {
    // A historical window must not leak the present into it.
    const out = filterTerrainData(data, { from: NOW - 40 * DAY, to: NOW - 20 * DAY, count: null }, NOW);
    expect(out.repos[0].files.map((f) => f.path)).toEqual(['old.py']);
  });

  it('strips out-of-range touches from the files it keeps', () => {
    const busy = makeData([
      { id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW - 1 * DAY, NOW - 40 * DAY])] },
    ]);
    const out = filterTerrainData(busy, { from: NOW - 7 * DAY, to: NOW, count: null }, NOW);
    // Only the in-range touch survives, so heat/age describe the chosen span.
    expect(out.repos[0].files[0].touches).toEqual([NOW - 1 * DAY]);
  });

  it('keeps a file whose session write lands in range even with no git touch', () => {
    const attributed = makeData([
      {
        id: 'r',
        name: 'R',
        root: '/',
        files: [file('uncommitted.py', [], [{ id: 's', title: 't', writes: 1, reads: 0, last: NOW - 2 * DAY }])],
      },
    ]);
    const out = filterTerrainData(attributed, { from: NOW - 7 * DAY, to: NOW, count: null }, NOW);
    expect(out.repos[0].files.map((f) => f.path)).toEqual(['uncommitted.py']);
  });

  it('drops sessions whose writes fall outside the range', () => {
    const attributed = makeData([
      {
        id: 'r',
        name: 'R',
        root: '/',
        files: [
          file('a.py', [NOW - 1 * DAY], [
            { id: 'recent', title: 't', writes: 1, reads: 0, last: NOW - 1 * DAY },
            { id: 'ancient', title: 't', writes: 1, reads: 0, last: NOW - 60 * DAY },
          ]),
        ],
      },
    ]);
    const out = filterTerrainData(attributed, { from: NOW - 7 * DAY, to: NOW, count: null }, NOW);
    expect(out.repos[0].files[0].sessions.map((s) => s.id)).toEqual(['recent']);
  });
});

describe('filterTerrainData — file count', () => {
  const many = makeData([
    {
      id: 'r',
      name: 'R',
      root: '/',
      files: [
        file('coldest.py', [NOW - 20 * DAY]),
        file('cold.py', [NOW - 10 * DAY]),
        file('warm.py', [NOW - 2 * DAY]),
        file('hottest.py', [NOW]),
      ],
    },
  ]);

  it('keeps the hottest N and drops the rest', () => {
    const out = filterTerrainData(many, { from: 0, to: NOW, count: 2 }, NOW);
    expect(out.repos[0].files.map((f) => f.path).sort()).toEqual(['hottest.py', 'warm.py']);
  });

  it('null count keeps everything', () => {
    const out = filterTerrainData(many, { from: 0, to: NOW, count: null }, NOW);
    expect(out.repos[0].files).toHaveLength(4);
  });

  it('a count above what exists is not an error', () => {
    const out = filterTerrainData(many, { from: 0, to: NOW, count: 9999 }, NOW);
    expect(out.repos[0].files).toHaveLength(4);
  });

  it('ranks across repos, not per repo', () => {
    const twoRepos = makeData([
      { id: 'a', name: 'A', root: '/a', files: [file('cold.py', [NOW - 30 * DAY])] },
      { id: 'b', name: 'B', root: '/b', files: [file('hot.py', [NOW])] },
    ]);
    const out = filterTerrainData(twoRepos, { from: 0, to: NOW, count: 1 }, NOW);
    // The single survivor is the globally hottest file — repo A keeps none.
    expect(out.repos.find((r) => r.id === 'a')!.files).toEqual([]);
    expect(out.repos.find((r) => r.id === 'b')!.files.map((f) => f.path)).toEqual(['hot.py']);
  });

  it('applies time before count — N hottest OF THE RANGE, not of all time', () => {
    const out = filterTerrainData(
      many,
      { from: NOW - 25 * DAY, to: NOW - 5 * DAY, count: 1 },
      NOW,
    );
    // hottest.py/warm.py are outside the range entirely; of what remains,
    // cold.py is the hotter — picking from the all-time top would have
    // returned nothing at all here.
    expect(out.repos[0].files.map((f) => f.path)).toEqual(['cold.py']);
  });

  it('never rewrites files_total — the honesty count survives every dial', () => {
    const capped = makeData([
      { id: 'r', name: 'R', root: '/', files: [file('a.py', [NOW]), file('b.py', [NOW])], files_total: 900 },
    ]);
    const out = filterTerrainData(capped, { from: 0, to: NOW, count: 1 }, NOW);
    expect(out.repos[0].files).toHaveLength(1);
    expect(out.repos[0].files_total).toBe(900);
  });
});

describe('sessionLastSeconds — the ISO-vs-epoch seam', () => {
  // The payload mixes units: files[].touches are unix seconds (git), while
  // files[].sessions[].last is an ISO-8601 string (footprints sidecar). Code
  // that guarded with `typeof x === 'number'` silently discarded every
  // session — which erased the agent orbs from the map entirely.
  const ISO = '2026-07-24T11:59:47.653Z';
  const EPOCH = Date.parse(ISO) / 1000;

  it('parses the ISO strings the server actually sends', () => {
    expect(sessionLastSeconds(ISO)).toBeCloseTo(EPOCH, 3);
  });

  it('still accepts a raw number, and refuses junk', () => {
    expect(sessionLastSeconds(1784895031)).toBe(1784895031);
    expect(sessionLastSeconds(null)).toBeNull();
    expect(sessionLastSeconds('not a date')).toBeNull();
  });

  it('an ISO-stamped session survives a range that contains it', () => {
    const d = makeData([
      {
        id: 'r',
        name: 'R',
        root: '/',
        files: [file('a.py', [], [{ id: 's', title: 't', writes: 1, reads: 0, last: ISO }])],
      },
    ]);
    const out = filterTerrainData(d, { from: EPOCH - 3600, to: EPOCH + 3600, count: null }, EPOCH);
    expect(out.repos[0].files).toHaveLength(1);
    expect(out.repos[0].files[0].sessions).toHaveLength(1);
  });

  it('ISO-stamped session writes count toward file heat', () => {
    // Previously the typeof guard dropped these, so a file an agent had just
    // written but git hadn't seen scored zero heat.
    const f = file('a.py', [], [{ id: 's', title: 't', writes: 1, reads: 0, last: ISO }]);
    expect(computeFileHeat(f, 'week', EPOCH)).toBeCloseTo(1, 6);
    expect(fileLastTouch(f)).toBeCloseTo(EPOCH, 3);
  });

  it('builds an orb for an ISO-stamped session', () => {
    const d = makeData([
      {
        id: 'r',
        name: 'R',
        root: '/',
        files: [file('a.py', [EPOCH], [{ id: 's', title: 'Agent run', writes: 1, reads: 0, last: ISO }])],
      },
    ]);
    const g = buildTerrainGraph(d, 'week', EPOCH);
    const orbs = g.nodes.filter((n) => n.kind === 'session');
    expect(orbs).toHaveLength(1);
    expect(orbs[0].session?.last).toBeCloseTo(EPOCH, 3);
  });

  it('keeps a session whose stamp is unusable rather than dropping it', () => {
    // Attribution is worth more than a timestamp we failed to parse.
    const d = makeData([
      {
        id: 'r',
        name: 'R',
        root: '/',
        files: [file('a.py', [NOW], [{ id: 's', title: 't', writes: 1, reads: 0, last: null }])],
      },
    ]);
    const out = filterTerrainData(d, { from: NOW - DAY, to: NOW, count: null }, NOW);
    expect(out.repos[0].files[0].sessions).toHaveLength(1);
  });
});

describe('terrain totals and bounds', () => {
  it('totals count every file the window holds, including server-cut ones', () => {
    const d = makeData([
      { id: 'a', name: 'A', root: '/a', files: [file('x.py', [NOW])], files_total: 500 },
      { id: 'b', name: 'B', root: '/b', files: [file('y.py', [NOW])], files_total: 700 },
    ]);
    expect(terrainFileTotal(d)).toBe(1200);   // the denominator
    expect(terrainFileLoaded(d)).toBe(2);     // what actually arrived
  });

  it('earliest touch spans both git touches and session writes', () => {
    const d = makeData([
      {
        id: 'r',
        name: 'R',
        root: '/',
        files: [
          file('a.py', [NOW - 5 * DAY]),
          file('b.py', [], [{ id: 's', title: 't', writes: 1, reads: 0, last: NOW - 40 * DAY }]),
        ],
      },
    ]);
    expect(terrainEarliestTouch(d, NOW)).toBe(NOW - 40 * DAY);
  });

  it('falls back to the payload window when nothing carries a timestamp', () => {
    const d = makeData([{ id: 'r', name: 'R', root: '/', files: [] }]);
    expect(terrainEarliestTouch(d, NOW)).toBe(NOW - 90 * DAY);
  });
});

// --- the backdrop's breath ---------------------------------------------------

describe('halfLifeSeconds', () => {
  it('resolves the named lenses', () => {
    expect(halfLifeSeconds('day')).toBe(LENS_HALF_LIFE_SECONDS.day);
    expect(halfLifeSeconds('month')).toBe(LENS_HALF_LIFE_SECONDS.month);
  });

  it('passes a raw half-life straight through', () => {
    expect(halfLifeSeconds(12_345)).toBe(12_345);
  });
});

describe('breathHalfLife', () => {
  const P = 10_000;

  it('starts tight at the day lens and swells to the month lens at the top of the inhale', () => {
    expect(breathHalfLife(0, P)).toBeCloseTo(LENS_HALF_LIFE_SECONDS.day, 3);
    expect(breathHalfLife(P * 0.4, P)).toBeCloseTo(LENS_HALF_LIFE_SECONDS.month, 3);
  });

  it('returns to the day lens by the end of the cycle', () => {
    expect(breathHalfLife(P, P)).toBeCloseTo(LENS_HALF_LIFE_SECONDS.day, 3);
  });

  it('never leaves the day..month band', () => {
    for (let t = 0; t <= P; t += P / 97) {
      const h = breathHalfLife(t, P);
      expect(h).toBeGreaterThanOrEqual(LENS_HALF_LIFE_SECONDS.day - 1e-6);
      expect(h).toBeLessThanOrEqual(LENS_HALF_LIFE_SECONDS.month + 1e-6);
    }
  });

  it('arrives at both turns with near-zero velocity — no flinch at the ends', () => {
    // Cosine easing, not a triangle wave: the derivative must vanish where the
    // breath reverses, or the turn reads as a jerk.
    const d = 1;
    const vStart = Math.abs(breathHalfLife(d, P) - breathHalfLife(0, P));
    const vMid = Math.abs(breathHalfLife(P / 4 + d, P) - breathHalfLife(P / 4, P));
    expect(vStart).toBeLessThan(vMid / 10);
  });

  it('exhales longer than it inhales — 4 in, 6 out', () => {
    // The peak sits at 40% of the cycle, so the settle has 60% to travel: at
    // any equal offset either side of the peak, the exhale is still higher up
    // the ramp than the inhale was, because it is moving slower.
    for (const d of [P / 20, P / 12, P / 8]) {
      expect(breathHalfLife(P * 0.4 + d, P)).toBeGreaterThan(breathHalfLife(P * 0.4 - d, P));
    }
  });

  it('is flat at the top of the breath — the turn from swell to settle is soft', () => {
    const d = 1;
    const vPeak = Math.abs(breathHalfLife(P * 0.4 + d, P) - breathHalfLife(P * 0.4, P));
    const vMidInhale = Math.abs(breathHalfLife(P * 0.2 + d, P) - breathHalfLife(P * 0.2, P));
    expect(vPeak).toBeLessThan(vMidInhale / 10);
  });

  it('spends the cycle evenly across the RATIO of memory, not the raw seconds', () => {
    // Interpolated in log space. A linear lerp would sit near `month` for most
    // of the cycle (day..month is a 30x span), making the swell slow and the
    // collapse abrupt. In log space the quarter point is the geometric mean.
    // Sampled at the midpoint of the INHALE (20% of the cycle, half of the 4s
    // swell) — the uneven breath moves the halfway point off P/4.
    const geometric = Math.sqrt(LENS_HALF_LIFE_SECONDS.day * LENS_HALF_LIFE_SECONDS.month);
    expect(breathHalfLife(P * 0.2, P)).toBeCloseTo(geometric, 3);
  });

  it('repeats across cycles and handles a negative elapsed', () => {
    expect(breathHalfLife(P * 3.25, P)).toBeCloseTo(breathHalfLife(P / 4, P), 6);
    expect(Number.isFinite(breathHalfLife(-P / 4, P))).toBe(true);
  });

  it('degrades to the day lens on a nonsense period rather than dividing by zero', () => {
    expect(breathHalfLife(500, 0)).toBe(LENS_HALF_LIFE_SECONDS.day);
  });
});

describe('computeFileHeat with a raw half-life', () => {
  it('matches the named lens it corresponds to', () => {
    const f = file('a.py', [NOW - 3600, NOW - 86400]);
    expect(computeFileHeat(f, LENS_HALF_LIFE_SECONDS.week, NOW)).toBeCloseTo(
      computeFileHeat(f, 'week', NOW),
      12,
    );
  });

  it('a wider half-life never cools a file — the breath only ever remembers more', () => {
    const f = file('a.py', [NOW - 20 * 86400]);
    const tight = computeFileHeat(f, LENS_HALF_LIFE_SECONDS.day, NOW);
    const wide = computeFileHeat(f, LENS_HALF_LIFE_SECONDS.month, NOW);
    expect(wide).toBeGreaterThan(tight);
  });

  it('lifts an OLD file far more than a fresh one — why this reads as memory, not brightness', () => {
    const fresh = file('fresh.py', [NOW - 600]);
    const old = file('old.py', [NOW - 20 * 86400]);
    const gain = (f: TerrainFile) =>
      computeFileHeat(f, LENS_HALF_LIFE_SECONDS.month, NOW) /
      Math.max(1e-9, computeFileHeat(f, LENS_HALF_LIFE_SECONDS.day, NOW));
    expect(gain(old)).toBeGreaterThan(gain(fresh) * 100);
  });
});

describe('sessionFileTouch / sessionTouchRings (focus rings)', () => {
  const modified = file('m.py', [NOW], [{ id: 's1', title: 'work', writes: 2, reads: 5, last: NOW - 60 }]);
  const readOnly = file('r.py', [NOW], [{ id: 's1', title: 'work', writes: 0, reads: 3, last: NOW - 90 }]);
  const attributed = file('a.py', [NOW], [{ id: 's1', title: 'work', writes: 0, reads: 0, last: NOW - 90 }]);
  const other = file('o.py', [NOW], [{ id: 's2', title: 'elsewhere', writes: 4, reads: 0, last: NOW - 30 }]);
  const created = file('n.py', [NOW], [{ id: 's1', title: 'work', writes: 1, reads: 0, creates: 1, last: NOW - 20 }]);

  it('reads a file it wrote as modified even when it also read it — the stronger signal wins', () => {
    expect(sessionFileTouch(modified, 's1')).toBe('modified');
  });

  it('reads a read-only file as read', () => {
    expect(sessionFileTouch(readOnly, 's1')).toBe('read');
  });

  it('treats a file attributed with no write count as read, not nothing', () => {
    expect(sessionFileTouch(attributed, 's1')).toBe('read');
  });

  it('reads a freshly-created file as created — the strongest signal, above modified', () => {
    expect(sessionFileTouch(created, 's1')).toBe('created');
  });

  it('returns null for a session that never touched the file', () => {
    expect(sessionFileTouch(other, 's1')).toBeNull();
  });

  it('rings exactly the focused session\'s files, classified per file', () => {
    const data = makeData([
      { id: 'skeleton', name: 'App code', root: '/app', files: [modified, readOnly, created, other] },
    ]);
    const g = buildTerrainGraph(data, 'week', NOW);
    const rings = sessionTouchRings(g.nodes, 's1');
    expect(rings.get('skeleton:file:m.py')).toBe('modified');
    expect(rings.get('skeleton:file:r.py')).toBe('read');
    expect(rings.get('skeleton:file:n.py')).toBe('created');
    // s2's file is not in s1's ring set.
    expect(rings.has('skeleton:file:o.py')).toBe(false);
  });
});

describe('formatAge / heatKeyTicks (the colour key, derived from the half-life)', () => {
  it('reproduces the old Day key exactly at a one-day half-life', () => {
    expect(heatKeyTicks(LENS_HALF_LIFE_SECONDS.day)).toEqual(['now', '6h', '1d+']);
  });

  it('scales with the bar — a longer half-life pushes both ticks older', () => {
    expect(heatKeyTicks(LENS_HALF_LIFE_SECONDS.week)).toEqual(['now', '2d', '7d+']);
    expect(heatKeyTicks(LENS_HALF_LIFE_SECONDS.month)).toEqual(['now', '8d', '30d+']);
  });

  it('always leads with now and marks the oldest tick as a floor', () => {
    for (const days of [1, 3, 9, 17, 30]) {
      const ticks = heatKeyTicks(days * 86400);
      expect(ticks[0]).toBe('now');
      expect(ticks[2].endsWith('+')).toBe(true);
    }
  });

  it('climbs minutes → hours → days without ever switching to weeks', () => {
    expect(formatAge(600)).toBe('10m');
    expect(formatAge(7200)).toBe('2h');
    expect(formatAge(86400 * 9)).toBe('9d');
  });

  it('never reports a zero age — the shortest label is a minute, not "0m"', () => {
    expect(formatAge(5)).toBe('1m');
  });
});

describe('heatTrackStops (the ramp painted along the heat slider)', () => {
  it('spans the track end to end so the gradient has no gap at either edge', () => {
    const stops = heatTrackStops(7);
    expect(stops[0].pct).toBe(0);
    expect(stops[stops.length - 1].pct).toBe(100);
  });

  it('reads as an age axis: the handle always lands on half-brightness', () => {
    // The handle sits at the half-life, and one half-life old is t=0.5 by
    // definition — so the colour under the thumb is the ramp's midpoint at
    // every setting. That invariant is what makes the bar legible while it
    // moves: the gradient slides past a fixed reference.
    for (const days of [1, 7, 30]) {
      const at = heatTrackStops(days, days, days, 1)[0];
      expect(at.t).toBeCloseTo(0.5, 10);
    }
  });

  it('cools monotonically left to right — near days hot, month-old cold', () => {
    const stops = heatTrackStops(7);
    for (let i = 1; i < stops.length; i += 1) {
      expect(stops[i].t).toBeLessThan(stops[i - 1].t);
    }
    expect(stops[0].t).toBeGreaterThan(0.9); // one day old under a week's memory
    expect(stops[stops.length - 1].t).toBeLessThan(0.1); // a month old, all but out
  });

  it('brightens the whole ramp as the half-life grows — a longer memory, shown', () => {
    const short = heatTrackStops(1);
    const long = heatTrackStops(30);
    for (let i = 0; i < short.length; i += 1) {
      expect(long[i].t).toBeGreaterThan(short[i].t);
    }
  });

  it('goes fully cold rather than dividing by zero on a zero half-life', () => {
    expect(heatTrackStops(0).every((s) => s.t === 0)).toBe(true);
  });
});

describe('sessionFootprintByRecency (which files a spotlit agent gets to name)', () => {
  const old = file('old.py', [NOW], [{ id: 's1', title: 'w', writes: 1, reads: 0, last: NOW - 9000 }]);
  const recent = file('recent.py', [NOW], [{ id: 's1', title: 'w', writes: 1, reads: 0, last: NOW - 60 }]);
  const mid = file('mid.py', [NOW], [{ id: 's1', title: 'w', writes: 1, reads: 0, last: NOW - 600 }]);
  const stampless = file('none.py', [NOW], [{ id: 's1', title: 'w', writes: 1, reads: 0, last: null }]);
  const other = file('other.py', [NOW], [{ id: 's2', title: 'x', writes: 1, reads: 0, last: NOW - 10 }]);

  function nodes() {
    return buildTerrainGraph(
      makeData([
        { id: 'skeleton', name: 'App code', root: '/app', files: [old, recent, mid, stampless, other] },
      ]),
      'week',
      NOW,
    ).nodes;
  }

  it('orders the footprint newest-touch-first', () => {
    expect(sessionFootprintByRecency(nodes(), 's1').slice(0, 3)).toEqual([
      'skeleton:file:recent.py',
      'skeleton:file:mid.py',
      'skeleton:file:old.py',
    ]);
  });

  it('keeps a file whose stamp it cannot read, at the back rather than dropping it', () => {
    const ids = sessionFootprintByRecency(nodes(), 's1');
    expect(ids).toHaveLength(4);
    expect(ids[ids.length - 1]).toBe('skeleton:file:none.py');
  });

  it('excludes files another agent touched', () => {
    expect(sessionFootprintByRecency(nodes(), 's1')).not.toContain('skeleton:file:other.py');
  });

  it('returns nothing for an agent with no footprint', () => {
    expect(sessionFootprintByRecency(nodes(), 'nobody')).toEqual([]);
  });
});

describe('agentTouchRings (every shown agent at once)', () => {
  const shared = file('shared.py', [NOW], [
    { id: 's1', title: 'reader', writes: 0, reads: 4, last: NOW - 60 },
    { id: 's2', title: 'writer', writes: 2, reads: 0, last: NOW - 30 },
  ]);
  const mine = file('m.py', [NOW], [{ id: 's1', title: 'reader', writes: 3, reads: 0, last: NOW - 60 }]);
  const theirs = file('t.py', [NOW], [{ id: 's3', title: 'absent', writes: 1, reads: 0, last: NOW - 60 }]);

  function graph() {
    return buildTerrainGraph(
      makeData([{ id: 'skeleton', name: 'App code', root: '/app', files: [shared, mine, theirs] }]),
      'week',
      NOW,
    );
  }

  it('rings files across every named agent, not just one', () => {
    const rings = agentTouchRings(graph().nodes, new Set(['s1', 's2']));
    expect(rings.get('skeleton:file:m.py')).toBe('modified');
    expect(rings.get('skeleton:file:shared.py')).toBeDefined();
  });

  it('takes the strongest touch when two agents touched the same file — a write outranks a read', () => {
    const rings = agentTouchRings(graph().nodes, new Set(['s1', 's2']));
    expect(rings.get('skeleton:file:shared.py')).toBe('modified');
  });

  it('reads the shared file as read when only its reader is shown', () => {
    const rings = agentTouchRings(graph().nodes, new Set(['s1']));
    expect(rings.get('skeleton:file:shared.py')).toBe('read');
  });

  it('leaves files untouched by any named agent unringed', () => {
    const rings = agentTouchRings(graph().nodes, new Set(['s1', 's2']));
    expect(rings.has('skeleton:file:t.py')).toBe(false);
  });

  it('rings nothing when no agents are shown', () => {
    expect(agentTouchRings(graph().nodes, new Set()).size).toBe(0);
  });
});

describe('the pond tile riding through the graph (days → dayHeats)', () => {
  const tile: TerrainFile = {
    path: 'tulku/_system/data/cards/pond',
    touches: [NOW, NOW - DAY],
    sessions: [],
    days: [
      { day: '2026-08-20', touches: [NOW - DAY] },
      { day: '2026-08-21', touches: [NOW] },
    ],
  };

  it('attaches a heat per day, on the same lens as the node itself', () => {
    const graph = buildTerrainGraph(
      makeData([{ id: 'v', name: 'V', root: '/', files: [tile] }]),
      'day',
      NOW,
    );
    const node = graph.nodes.find((n) => n.kind === 'file')!;
    expect(node.dayHeats).toHaveLength(2);
    expect(node.dayHeats![0]).toBeCloseTo(0.5, 6); // one touch, one half-life old
    expect(node.dayHeats![1]).toBeCloseTo(1, 6);
  });

  it('leaves ordinary files without dayHeats', () => {
    const graph = buildTerrainGraph(
      makeData([{ id: 'v', name: 'V', root: '/', files: [file('a.py', [NOW])] }]),
      'day',
      NOW,
    );
    expect(graph.nodes.find((n) => n.kind === 'file')!.dayHeats).toBeUndefined();
  });

  it('bucketHeat matches computeFileHeat for bare touches', () => {
    expect(bucketHeat([NOW - DAY], 'day', NOW)).toBeCloseTo(
      computeFileHeat(file('x', [NOW - DAY]), 'day', NOW),
      6,
    );
  });

  it('filterTerrainData cuts the date dial into the day buckets too', () => {
    const out = filterTerrainData(
      makeData([{ id: 'v', name: 'V', root: '/', files: [tile] }]),
      { from: NOW - DAY / 2, to: NOW, count: null },
      NOW,
    );
    const kept = out.repos[0].files[0];
    expect(kept.days![0].touches).toEqual([]); // yesterday fell outside the range
    expect(kept.days![1].touches).toEqual([NOW]);
  });
});
