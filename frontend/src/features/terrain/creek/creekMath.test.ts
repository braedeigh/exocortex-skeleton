import { describe, expect, it } from 'vitest';
import type { CreekCaller, CreekCollection, CreekFile } from './api';
import {
  CALLER_ROLES,
  DIM_OPACITY,
  FRESHNESS_FLOOR,
  FRESHNESS_HALF_LIFE_HOURS,
  QUIET_OPACITY,
  GROUP_GAP,
  HEADER_H,
  LEFT_X,
  LIT_READ_OPACITY,
  LIT_WRITE_OPACITY,
  MAX_STROKE,
  MIN_STROKE,
  READ_BASE_OPACITY,
  READ_STROKE,
  RIGHT_X,
  ROW_GAP,
  ROW_H,
  WRITE_BASE_OPACITY,
  activeCollections,
  aggregateCallers,
  buildRibbons,
  buildTrafficRibbons,
  callerDimmed,
  classifyDiffLine,
  codeHref,
  collectionDimmed,
  collectionRowOpacity,
  fileDimmed,
  freshnessAt,
  halfLifeForWindow,
  layoutCallers,
  fileReads,
  fileWrites,
  filesTouching,
  freshnessFactor,
  layoutCollections,
  layoutFiles,
  relativeDay,
  relativeDayTime,
  ribbonDimmed,
  ribbonOpacity,
  ribbonPathD,
  ribbonRenderWidth,
  ribbonStrokeWidth,
  ribbonWeight,
  selectionSets,
  sortMetricFor,
  sortedCalls,
  sortedCallers,
  sortedTouches,
  toggleLayer,
  trafficCountLabel,
  trafficRowOpacity,
  trafficSelectionSets,
  visibleRibbons,
  writeState,
} from './creekMath';

function file(path: string, area: CreekFile['area'], calls: CreekFile['calls']): CreekFile {
  return { path, area, calls };
}

function collection(
  id: string,
  backing: CreekCollection['backing'],
  over: Partial<CreekCollection> = {},
): CreekCollection {
  return {
    id,
    backing,
    reads: 0,
    writes: 0,
    callers: [],
    last_write: null,
    last_write_day: null,
    ...over,
  };
}

describe('fileWrites / fileReads', () => {
  it('counts write and mutate as writes, read as reads', () => {
    const f = file('routes/todos.py', 'routes', [
      { line: 1, verb: 'read', collection: 'todos', snippet: 'a' },
      { line: 2, verb: 'write', collection: 'todos', snippet: 'b' },
      { line: 3, verb: 'mutate', collection: 'todos', snippet: 'c' },
    ]);
    expect(fileWrites(f)).toBe(2);
    expect(fileReads(f)).toBe(1);
  });
});

describe('layoutFiles', () => {
  it('groups by area in server/routes/scripts/tools order and skips empty groups', () => {
    const files = [
      file('routes/a.py', 'routes', []),
      file('server.py', 'server', []),
      file('tools/x.py', 'tools', []),
    ];
    const bank = layoutFiles(files);
    expect(bank.headers.map((h) => h.key)).toEqual(['server', 'routes', 'tools']);
  });

  it('sorts within a group by writes descending, ties by path', () => {
    const write = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        line: i,
        verb: 'write' as const,
        collection: 'x',
        snippet: '',
      }));
    const files = [
      file('routes/b.py', 'routes', write(1)),
      file('routes/a.py', 'routes', write(3)),
      file('routes/c.py', 'routes', write(1)),
    ];
    const bank = layoutFiles(files);
    expect(bank.rows.map((r) => r.key)).toEqual(['routes/a.py', 'routes/b.py', 'routes/c.py']);
  });

  it('rows sit at a fixed height, stacked with no overlap', () => {
    const files = [file('server.py', 'server', []), file('server2.py', 'server', [])];
    const bank = layoutFiles(files);
    expect(bank.rows[0].y).toBeGreaterThanOrEqual(0);
    expect(bank.rows[1].y - bank.rows[0].y).toBe(ROW_H + ROW_GAP);
    expect(bank.rows[0].cy).toBe(bank.rows[0].y + ROW_H / 2);
  });

  it('height grows to cover headers, rows and group gaps', () => {
    const files = [file('server.py', 'server', [])];
    const bank = layoutFiles(files);
    // top pad + one header + one row + trailing group gap, at minimum
    expect(bank.height).toBeGreaterThanOrEqual(HEADER_H + ROW_H + GROUP_GAP);
  });

  it('sorts by reads descending instead, when the metric is "reads"', () => {
    const reads = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        line: i,
        verb: 'read' as const,
        collection: 'x',
        snippet: '',
      }));
    const files = [
      file('routes/b.py', 'routes', reads(1)),
      file('routes/a.py', 'routes', reads(3)),
    ];
    const bank = layoutFiles(files, 'reads');
    expect(bank.rows.map((r) => r.key)).toEqual(['routes/a.py', 'routes/b.py']);
  });
});

describe('layoutCollections', () => {
  it('groups sql before json and sorts by writes descending by default', () => {
    const cols = [
      collection('cache', 'json', { writes: 1 }),
      collection('todos', 'sql', { writes: 5 }),
      collection('cards', 'sql', { writes: 9 }),
    ];
    const bank = layoutCollections(cols);
    expect(bank.headers.map((h) => h.key)).toEqual(['sql', 'json']);
    expect(bank.rows.map((r) => r.key)).toEqual(['cards', 'todos', 'cache']);
  });

  it('sorts by reads descending instead, when the metric is "reads"', () => {
    const cols = [
      collection('cache', 'json', { writes: 9, reads: 1 }),
      collection('todos', 'sql', { writes: 1, reads: 9 }),
    ];
    const bank = layoutCollections(cols, 'reads');
    expect(bank.rows.map((r) => r.key)).toEqual(['todos', 'cache']);
  });
});

describe('sortMetricFor', () => {
  it('sorts by writes whenever writes are on, regardless of reads', () => {
    expect(sortMetricFor(true, true)).toBe('writes');
    expect(sortMetricFor(true, false)).toBe('writes');
  });

  it('sorts by reads only once writes are off (reads-only mode)', () => {
    expect(sortMetricFor(false, true)).toBe('reads');
  });

  it('falls back to writes if somehow both are off, rather than throwing', () => {
    expect(sortMetricFor(false, false)).toBe('writes');
  });
});

describe('ribbonWeight', () => {
  it('is zero for no writes', () => {
    expect(ribbonWeight(0, 40)).toBe(0);
  });

  it('floors at 0.35 for the lightest real flow, never fading a real write to nothing', () => {
    const w = ribbonWeight(1, 40);
    expect(w).toBeGreaterThanOrEqual(0.35);
    expect(w).toBeLessThan(0.5);
  });

  it('reaches 1 exactly at the cap', () => {
    expect(ribbonWeight(40, 40)).toBeCloseTo(1, 5);
  });

  it('never exceeds 1 for a flow heavier than the given cap', () => {
    expect(ribbonWeight(100, 40)).toBeLessThanOrEqual(1);
  });

  it('is monotonic — a busier flow never draws thinner than a quieter one', () => {
    expect(ribbonWeight(5, 40)).toBeGreaterThan(ribbonWeight(1, 40));
    expect(ribbonWeight(20, 40)).toBeGreaterThan(ribbonWeight(5, 40));
  });
});

describe('ribbonStrokeWidth', () => {
  it('spans MIN_STROKE..MAX_STROKE across weight 0..1', () => {
    expect(ribbonStrokeWidth(0)).toBe(MIN_STROKE);
    expect(ribbonStrokeWidth(1)).toBe(MAX_STROKE);
  });
});

describe('ribbonRenderWidth', () => {
  it('writes always use the write log-ramp, whatever readsOwnScale is', () => {
    expect(ribbonRenderWidth('write', 0.5, false)).toBe(ribbonStrokeWidth(0.5));
    expect(ribbonRenderWidth('write', 0.5, true)).toBe(ribbonStrokeWidth(0.5));
  });

  it('reads stay a fixed hairline when writes are still visible', () => {
    expect(ribbonRenderWidth('read', 0.9, false)).toBe(READ_STROKE);
  });

  it('reads get their own log-ramp width in reads-only mode', () => {
    expect(ribbonRenderWidth('read', 0.9, true)).toBe(ribbonStrokeWidth(0.9));
    expect(ribbonRenderWidth('read', 0.9, true)).not.toBe(READ_STROKE);
  });
});

describe('ribbonOpacity', () => {
  it('dimmed always wins, regardless of kind, lit, or freshness', () => {
    expect(ribbonOpacity('write', true, true)).toBe(DIM_OPACITY);
    expect(ribbonOpacity('read', true, false)).toBe(DIM_OPACITY);
    expect(ribbonOpacity('write', true, true, 0.25)).toBe(DIM_OPACITY);
  });

  it('lit writes go fully saturated; lit reads stay well below full', () => {
    expect(ribbonOpacity('write', false, true)).toBe(LIT_WRITE_OPACITY);
    expect(ribbonOpacity('read', false, true)).toBe(LIT_READ_OPACITY);
    expect(ribbonOpacity('read', false, true)).toBeLessThan(ribbonOpacity('write', false, true));
  });

  it('resting state: writes carry more ink than reads', () => {
    expect(ribbonOpacity('write', false, false)).toBe(WRITE_BASE_OPACITY);
    expect(ribbonOpacity('read', false, false)).toBe(READ_BASE_OPACITY);
    expect(WRITE_BASE_OPACITY).toBeGreaterThan(READ_BASE_OPACITY);
  });

  it('defaults freshness to 1 — unchanged behavior for callers that never pass it', () => {
    expect(ribbonOpacity('write', false, false)).toBe(ribbonOpacity('write', false, false, 1));
  });

  it('multiplies freshness into a non-dimmed ribbon (Today mode’s recency fade)', () => {
    expect(ribbonOpacity('write', false, false, 0.5)).toBeCloseTo(WRITE_BASE_OPACITY * 0.5, 5);
    expect(ribbonOpacity('write', false, true, 0.5)).toBeCloseTo(LIT_WRITE_OPACITY * 0.5, 5);
  });
});

describe('collectionRowOpacity', () => {
  it('dimmed always wins outright, ignoring freshness', () => {
    expect(collectionRowOpacity(true, 1)).toBe(DIM_OPACITY);
    expect(collectionRowOpacity(true, 0.25)).toBe(DIM_OPACITY);
  });

  it('otherwise the row opacity IS the freshness', () => {
    expect(collectionRowOpacity(false, 1)).toBe(1);
    expect(collectionRowOpacity(false, 0.4)).toBe(0.4);
  });
});

describe('freshnessFactor', () => {
  const now = new Date(2026, 7, 21, 15, 0); // Aug 21 2026, 15:00 local

  it('is 1 for a write that just happened', () => {
    expect(freshnessFactor(now.toISOString(), now)).toBeCloseTo(1, 5);
  });

  it('decays across the half-life-ish window rather than jumping straight to the floor', () => {
    const sixHoursAgo = new Date(now.getTime() - 6 * 3_600_000).toISOString();
    const w = freshnessFactor(sixHoursAgo, now);
    expect(w).toBeGreaterThan(FRESHNESS_FLOOR);
    expect(w).toBeLessThan(1);
    expect(w).toBeCloseTo(Math.exp(-1), 5);
  });

  it('floors at FRESHNESS_FLOOR for anything old enough, never fading to zero', () => {
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString();
    expect(freshnessFactor(monthAgo, now)).toBe(FRESHNESS_FLOOR);
  });

  it('reads null (journal has nothing for this collection) as the same floor, not zero', () => {
    expect(freshnessFactor(null, now)).toBe(FRESHNESS_FLOOR);
  });

  it('treats an unparseable timestamp the same as null rather than throwing', () => {
    expect(freshnessFactor('not-a-date', now)).toBe(FRESHNESS_FLOOR);
  });

  it('is monotonic — a more recent write never reads staler than an older one', () => {
    const oneHourAgo = new Date(now.getTime() - 1 * 3_600_000).toISOString();
    const twelveHoursAgo = new Date(now.getTime() - 12 * 3_600_000).toISOString();
    expect(freshnessFactor(oneHourAgo, now)).toBeGreaterThan(freshnessFactor(twelveHoursAgo, now));
  });
});

describe('toggleLayer', () => {
  it('flips the tapped layer normally when the other one is already on', () => {
    expect(toggleLayer(true, true, 'writes')).toEqual({ writesOn: false, readsOn: true });
    expect(toggleLayer(true, true, 'reads')).toEqual({ writesOn: true, readsOn: false });
  });

  it('never lands on both off — killing the last lit chip lights the other one', () => {
    expect(toggleLayer(true, false, 'writes')).toEqual({ writesOn: false, readsOn: true });
    expect(toggleLayer(false, true, 'reads')).toEqual({ writesOn: true, readsOn: false });
  });

  it('turning ON a layer never touches the other one', () => {
    expect(toggleLayer(false, true, 'writes')).toEqual({ writesOn: true, readsOn: true });
    expect(toggleLayer(true, false, 'reads')).toEqual({ writesOn: true, readsOn: true });
  });
});

describe('ribbonPathD', () => {
  it('starts and ends exactly at the given endpoints', () => {
    const d = ribbonPathD(10, 20, 300, 400);
    expect(d.startsWith('M 10.0,20.0')).toBe(true);
    expect(d.endsWith('300.0,400.0')).toBe(true);
  });
});

describe('buildRibbons', () => {
  const files = [
    file('routes/todos.py', 'routes', [
      { line: 10, verb: 'write', collection: 'todos', snippet: 'store.save(todos)' },
      { line: 11, verb: 'write', collection: 'todos', snippet: 'store.save(todos)' },
      { line: 20, verb: 'read', collection: 'cards', snippet: 'store.load(cards)' },
    ]),
  ];
  const collections = [collection('todos', 'json'), collection('cards', 'sql')];
  const fileBank = layoutFiles(files);
  const collectionBank = layoutCollections(collections);

  it('emits one write ribbon and one read ribbon, endpoints at the row centres', () => {
    const ribbons = buildRibbons(files, fileBank, collectionBank, LEFT_X, RIGHT_X);
    expect(ribbons).toHaveLength(2);

    const write = ribbons.find((r) => r.kind === 'write')!;
    expect(write.source).toBe('routes/todos.py');
    expect(write.collection).toBe('todos');
    expect(write.count).toBe(2);
    expect(write.weight).toBeGreaterThan(0);

    const read = ribbons.find((r) => r.kind === 'read')!;
    expect(read.collection).toBe('cards');
    expect(read.count).toBe(1);
    // Only one read in the whole payload, so it IS the read cap — the
    // read-side log ramp should already give it a real (non-zero) weight,
    // even though 14-day/both-on mode never draws it wide.
    expect(read.weight).toBeGreaterThan(0);

    const fileRow = fileBank.rows.find((r) => r.key === 'routes/todos.py')!;
    const colRow = collectionBank.rows.find((r) => r.key === 'todos')!;
    expect(write.d).toContain(`${LEFT_X.toFixed(1)},${fileRow.cy.toFixed(1)}`);
    expect(write.d).toContain(`${colRow.cy.toFixed(1)}`);
  });

  it('skips a call whose collection never appears in the bank', () => {
    const orphan = [file('routes/x.py', 'routes', [
      { line: 1, verb: 'write', collection: 'nowhere', snippet: '' },
    ])];
    const ribbons = buildRibbons(orphan, layoutFiles(orphan), collectionBank, LEFT_X, RIGHT_X);
    expect(ribbons).toHaveLength(0);
  });

  it('computes the read log-ramp against its OWN cap, never the write cap', () => {
    // One file writes heavily to `todos` (busy write flow) and reads lightly
    // from `cards`; another reads `cards` heavily. If reads borrowed the
    // write cap, the heavy write flow would flatten the read weights near
    // zero — they must not.
    const heavy = [
      file('routes/todos.py', 'routes', [
        ...Array.from({ length: 50 }, (_, i) => ({
          line: i,
          verb: 'write' as const,
          collection: 'todos',
          snippet: '',
        })),
        { line: 100, verb: 'read' as const, collection: 'cards', snippet: '' },
      ]),
      file('routes/cards.py', 'routes', [
        ...Array.from({ length: 20 }, (_, i) => ({
          line: i,
          verb: 'read' as const,
          collection: 'cards',
          snippet: '',
        })),
      ]),
    ];
    const fBank = layoutFiles(heavy);
    const cBank = layoutCollections(collections);
    const ribbons = buildRibbons(heavy, fBank, cBank, LEFT_X, RIGHT_X);
    const heavyRead = ribbons.find((r) => r.source === 'routes/cards.py' && r.kind === 'read')!;
    // 20 out of a 20-read cap should land at (or very near) the top of the
    // read ramp — nowhere close to how flattened it'd be against a 50-write cap.
    expect(heavyRead.weight).toBeCloseTo(1, 1);
  });
});

describe('visibleRibbons', () => {
  const ribbons = [
    { source: 'a', collection: 'b', kind: 'write' as const, count: 1, weight: 1, d: '' },
    { source: 'a', collection: 'b', kind: 'read' as const, count: 1, weight: 0, d: '' },
  ];

  it('drops read ribbons when the reads chip is off', () => {
    expect(visibleRibbons(ribbons, true, false)).toEqual([ribbons[0]]);
  });

  it('drops write ribbons when the writes chip is off (reads-only mode)', () => {
    expect(visibleRibbons(ribbons, false, true)).toEqual([ribbons[1]]);
  });

  it('keeps everything when both chips are on', () => {
    expect(visibleRibbons(ribbons, true, true)).toHaveLength(2);
  });

  it('drops everything if both were somehow off, rather than assuming a default', () => {
    expect(visibleRibbons(ribbons, false, false)).toHaveLength(0);
  });
});

describe('selection lighting', () => {
  const files = [
    file('routes/todos.py', 'routes', [
      { line: 1, verb: 'write', collection: 'todos', snippet: '' },
    ]),
    file('routes/cards.py', 'routes', [
      { line: 1, verb: 'write', collection: 'cards', snippet: '' },
    ]),
  ];

  it('no selection dims nothing', () => {
    const sets = selectionSets(null, files);
    expect(fileDimmed(null, sets, 'routes/todos.py')).toBe(false);
    expect(collectionDimmed(null, sets, 'todos')).toBe(false);
    expect(ribbonDimmed(null, 'routes/todos.py', 'todos')).toBe(false);
  });

  it('selecting a file lights only its own collections and itself', () => {
    const sel = { kind: 'file' as const, path: 'routes/todos.py' };
    const sets = selectionSets(sel, files);
    expect(sets.collections.has('todos')).toBe(true);
    expect(sets.collections.has('cards')).toBe(false);

    expect(fileDimmed(sel, sets, 'routes/todos.py')).toBe(false);
    expect(fileDimmed(sel, sets, 'routes/cards.py')).toBe(true);
    expect(collectionDimmed(sel, sets, 'todos')).toBe(false);
    expect(collectionDimmed(sel, sets, 'cards')).toBe(true);
    expect(ribbonDimmed(sel, 'routes/todos.py', 'todos')).toBe(false);
    expect(ribbonDimmed(sel, 'routes/cards.py', 'cards')).toBe(true);
  });

  it('selecting a collection lights the files that touch it', () => {
    const sel = { kind: 'collection' as const, id: 'cards' };
    const sets = selectionSets(sel, files);
    expect(sets.files.has('routes/cards.py')).toBe(true);
    expect(sets.files.has('routes/todos.py')).toBe(false);
    expect(fileDimmed(sel, sets, 'routes/cards.py')).toBe(false);
    expect(fileDimmed(sel, sets, 'routes/todos.py')).toBe(true);
  });
});

describe('sortedCalls / sortedCallers / filesTouching', () => {
  it('orders a file’s calls by line ascending', () => {
    const f = file('x.py', 'server', [
      { line: 30, verb: 'read', collection: 'a', snippet: '' },
      { line: 5, verb: 'write', collection: 'a', snippet: '' },
    ]);
    expect(sortedCalls(f).map((c) => c.line)).toEqual([5, 30]);
  });

  it('orders a collection’s callers busiest first', () => {
    const c = collection('todos', 'json', {
      callers: [
        { name: 'quiet-agent', reads: 1, writes: 0, file: null },
        { name: 'busy-agent', reads: 3, writes: 5, file: null },
      ],
    });
    expect(sortedCallers(c).map((x) => x.name)).toEqual(['busy-agent', 'quiet-agent']);
  });

  it('finds every file that calls into a given collection', () => {
    const files = [
      file('a.py', 'server', [{ line: 1, verb: 'read', collection: 'todos', snippet: '' }]),
      file('b.py', 'server', [{ line: 1, verb: 'read', collection: 'cards', snippet: '' }]),
    ];
    expect(filesTouching(files, 'todos').map((f) => f.path)).toEqual(['a.py']);
  });
});

describe('codeHref', () => {
  it('emits a skeleton-repo /code URL with a single-line range', () => {
    expect(codeHref('routes/todos.py', 42)).toBe(
      '/code?repo=skeleton&path=routes%2Ftodos.py&lines=42-42',
    );
  });
});

describe('relativeDayTime', () => {
  const now = new Date(2026, 7, 21, 15, 30); // Aug 21 2026, 15:30 local

  it('labels a timestamp from today as "Today HH:MM"', () => {
    const ts = new Date(2026, 7, 21, 9, 5).toISOString();
    expect(relativeDayTime(ts, now)).toBe('Today 09:05');
  });

  it('labels a timestamp just after midnight today as "Today", not yesterday', () => {
    const ts = new Date(2026, 7, 21, 0, 5).toISOString();
    expect(relativeDayTime(ts, now)).toBe('Today 00:05');
  });

  it('labels yesterday by calendar day, not a rolling 24h window', () => {
    const ts = new Date(2026, 7, 20, 23, 50).toISOString();
    expect(relativeDayTime(ts, now)).toBe('Yesterday 23:50');
  });

  it('falls back to "Mon D HH:MM" for anything older', () => {
    const ts = new Date(2026, 7, 18, 9, 15).toISOString();
    expect(relativeDayTime(ts, now)).toBe('Aug 18 09:15');
  });

  it('returns the raw string for an unparseable timestamp rather than throwing', () => {
    expect(relativeDayTime('not-a-date', now)).toBe('not-a-date');
  });
});

describe('classifyDiffLine', () => {
  it('classifies an added line', () => {
    expect(classifyDiffLine('+new content')).toBe('add');
  });

  it('classifies a removed line', () => {
    expect(classifyDiffLine('-old content')).toBe('del');
  });

  it('classifies a hunk header', () => {
    expect(classifyDiffLine('@@ -1,3 +1,4 @@')).toBe('hunk');
  });

  it('classifies file headers as meta, not add/del, despite the leading +/-', () => {
    expect(classifyDiffLine('+++ b/data/todos.json')).toBe('meta');
    expect(classifyDiffLine('--- a/data/todos.json')).toBe('meta');
    expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta');
    expect(classifyDiffLine('index abc123..def456 100644')).toBe('meta');
  });

  it('classifies a plain context line', () => {
    expect(classifyDiffLine('  unchanged line')).toBe('ctx');
    expect(classifyDiffLine('')).toBe('ctx');
  });
});

// --- traffic mode ------------------------------------------------------------
// The bug these cover: the creek drew one picture that meant two things. Ribbon
// widths came from a static call-site scan and did NOT change between modes, so
// a collection nothing had touched all day still drew a fat write ribbon and
// read as busy. Traffic mode is the measured picture; these tests pin the seam
// between the two so a count can never leak into the wiring map, nor a call
// site into the traffic map.

function caller(name: string, over: Partial<CreekCaller> = {}): CreekCaller {
  return { name, reads: 0, writes: 0, file: null, ...over };
}

describe('writeState', () => {
  it('calls zero writes quiet, whatever the journal says', () => {
    expect(writeState(0, null)).toBe('quiet');
    expect(writeState(0, '2026-08-21T22:00:00')).toBe('quiet');
  });

  it('separates "moved but untimestamped" from "moved"', () => {
    expect(writeState(7, null)).toBe('timeless');
    expect(writeState(7, '2026-08-21T22:00:00')).toBe('moved');
  });
});

describe('trafficRowOpacity', () => {
  it('lets dimmed win outright over every state', () => {
    for (const s of ['moved', 'timeless', 'quiet'] as const) {
      expect(trafficRowOpacity(s, true, 1)).toBe(DIM_OPACITY);
    }
  });

  it('draws an untimestamped write at FULL strength, never faded', () => {
    // It definitely happened — fading it would understate a known fact, which
    // is precisely the conflation this state exists to end.
    expect(trafficRowOpacity('timeless', false, 0.01)).toBe(1);
  });

  it('gives quiet its own opacity, distinct from any freshness value', () => {
    expect(trafficRowOpacity('quiet', false, 1)).toBe(QUIET_OPACITY);
    expect(QUIET_OPACITY).not.toBe(FRESHNESS_FLOOR);
  });

  it('fades a timestamped write by recency, floored', () => {
    expect(trafficRowOpacity('moved', false, 0.8)).toBeCloseTo(0.8);
    expect(trafficRowOpacity('moved', false, 0)).toBe(FRESHNESS_FLOOR);
  });
});

describe('aggregateCallers', () => {
  const collections = [
    collection('run_queue', 'json', {
      writes: 3333,
      callers: [caller('run_dispatcher', { writes: 3333, reads: 1601 })],
    }),
    collection('scheduled_runs', 'json', {
      writes: 1354,
      callers: [
        caller('run_dispatcher', { writes: 729, reads: 0 }),
        caller('gunicorn', { writes: 625, reads: 1368, file: null }),
      ],
    }),
  ];

  it('inverts the payload: one row per caller, summed across collections', () => {
    const out = aggregateCallers(collections);
    const dispatcher = out.find((c) => c.name === 'run_dispatcher')!;
    expect(dispatcher.writes).toBe(3333 + 729);
    expect(dispatcher.reads).toBe(1601);
    expect(dispatcher.touches).toHaveLength(2);
  });

  it('keeps totals equal to the sum of its own touches', () => {
    for (const c of aggregateCallers(collections)) {
      expect(c.writes).toBe(c.touches.reduce((n, t) => n + t.writes, 0));
      expect(c.reads).toBe(c.touches.reduce((n, t) => n + t.reads, 0));
    }
  });

  it('takes the first non-null file rather than the first touch’s null', () => {
    const out = aggregateCallers([
      collection('a', 'json', { callers: [caller('usage_rollup', { writes: 1 })] }),
      collection('b', 'json', {
        callers: [caller('usage_rollup', { writes: 1, file: 'scripts/usage_rollup.py' })],
      }),
    ]);
    expect(out[0].file).toBe('scripts/usage_rollup.py');
  });
});

describe('activeCollections', () => {
  it('drops what nothing touched, keeps a read-only collection', () => {
    const out = activeCollections([
      collection('budget', 'sql'),
      collection('recap_summaries', 'sql', { reads: 90768, writes: 370 }),
      collection('food_guide', 'json', { reads: 4 }),
    ]);
    expect(out.map((c) => c.id)).toEqual(['recap_summaries', 'food_guide']);
  });
});

describe('layoutCallers', () => {
  const callers = aggregateCallers([
    collection('x', 'json', {
      callers: [
        caller('gunicorn', { writes: 10, reads: 900 }),
        caller('prompt_dispatcher', { writes: 0, reads: 1354 }),
        caller('run_dispatcher', { writes: 4062, reads: 12 }),
      ],
    }),
  ]);

  it('puts writers above read-only callers, each ranked by the metric', () => {
    const bank = layoutCallers(callers, 'writes');
    expect(bank.headers.map((h) => h.key)).toEqual(CALLER_ROLES.map((r) => r.key));
    expect(bank.rows.map((r) => r.key)).toEqual([
      'run_dispatcher',
      'gunicorn',
      'prompt_dispatcher',
    ]);
  });

  it('re-ranks within the groups when reads own the scale', () => {
    const bank = layoutCallers(callers, 'reads');
    // gunicorn out-reads run_dispatcher, but is still a writer — the group
    // split is about role, not about which count is on screen.
    expect(bank.rows.map((r) => r.key)).toEqual([
      'gunicorn',
      'run_dispatcher',
      'prompt_dispatcher',
    ]);
  });
});

describe('buildTrafficRibbons', () => {
  const collections = [
    collection('run_queue', 'json', {
      reads: 1601,
      writes: 3333,
      callers: [caller('run_dispatcher', { writes: 3333, reads: 1601 })],
    }),
    collection('token_usage', 'json', {
      reads: 23,
      writes: 23,
      callers: [caller('usage_ledger', { writes: 23, reads: 23 })],
    }),
  ];
  const callers = aggregateCallers(collections);
  const callerBank = layoutCallers(callers);
  const collectionBank = layoutCollections(collections);

  it('carries the count that actually happened, not a call-site tally', () => {
    const ribbons = buildTrafficRibbons(callers, callerBank, collectionBank, LEFT_X, RIGHT_X);
    const write = ribbons.find((r) => r.source === 'run_dispatcher' && r.kind === 'write')!;
    expect(write.count).toBe(3333);
    expect(write.collection).toBe('run_queue');
  });

  it('lands its endpoints on the two banks’ own row centres', () => {
    const ribbons = buildTrafficRibbons(callers, callerBank, collectionBank, LEFT_X, RIGHT_X);
    const write = ribbons.find((r) => r.source === 'usage_ledger' && r.kind === 'write')!;
    const cy1 = callerBank.rows.find((r) => r.key === 'usage_ledger')!.cy;
    const cy2 = collectionBank.rows.find((r) => r.key === 'token_usage')!.cy;
    expect(write.d).toContain(`${LEFT_X.toFixed(1)},${cy1.toFixed(1)}`);
    expect(write.d).toContain(`${RIGHT_X.toFixed(1)},${cy2.toFixed(1)}`);
  });

  it('draws nothing toward a collection that isn’t on the bank', () => {
    // A quiet collection is filtered off the right bank by definition, so a
    // caller listed against it must not leave a dangling ribbon.
    const bankWithoutRunQueue = layoutCollections([collections[1]]);
    const ribbons = buildTrafficRibbons(
      callers,
      callerBank,
      bankWithoutRunQueue,
      LEFT_X,
      RIGHT_X,
    );
    expect(ribbons.some((r) => r.collection === 'run_queue')).toBe(false);
  });

  it('scales reads against their own cap, never the write cap', () => {
    const heavyWrite = [
      collection('run_queue', 'json', {
        reads: 5,
        writes: 9000,
        callers: [caller('run_dispatcher', { writes: 9000, reads: 5 })],
      }),
      collection('recaps', 'json', {
        reads: 60,
        writes: 0,
        callers: [caller('gunicorn', { writes: 0, reads: 60 })],
      }),
    ];
    const cs = aggregateCallers(heavyWrite);
    const ribbons = buildTrafficRibbons(
      cs,
      layoutCallers(cs),
      layoutCollections(heavyWrite),
      LEFT_X,
      RIGHT_X,
    );
    const topRead = ribbons.find((r) => r.source === 'gunicorn' && r.kind === 'read')!;
    // 60 of a 60-read cap sits at the top of the read ramp — a 9000-write cap
    // would have flattened it to nothing.
    expect(topRead.weight).toBeCloseTo(1, 1);
  });

  it('is the whole point: a wired-but-untouched collection draws no traffic ribbon', () => {
    // routes/money.py really does contain four `store.write("budget.json")`
    // lines, so wiring draws a write ribbon into budget — correctly. Traffic
    // must not, on a day nothing wrote it.
    const files = [
      file('routes/money.py', 'routes', [
        { line: 34, verb: 'write', collection: 'budget', snippet: '' },
        { line: 52, verb: 'write', collection: 'budget', snippet: '' },
      ]),
    ];
    const budget = [collection('budget', 'sql')];
    const wiring = buildRibbons(files, layoutFiles(files), layoutCollections(budget));
    expect(wiring.filter((r) => r.kind === 'write')).toHaveLength(1);

    const shown = activeCollections(budget);
    expect(shown).toHaveLength(0);
    const cs = aggregateCallers(budget);
    const trafficRibbons = buildTrafficRibbons(cs, layoutCallers(cs), layoutCollections(shown));
    expect(trafficRibbons).toHaveLength(0);
  });
});

describe('trafficSelectionSets', () => {
  const callers = aggregateCallers([
    collection('run_queue', 'json', {
      writes: 10,
      callers: [caller('run_dispatcher', { writes: 10 })],
    }),
    collection('token_usage', 'json', {
      writes: 2,
      callers: [
        caller('usage_ledger', { writes: 2 }),
        caller('run_dispatcher', { writes: 0, reads: 0 }),
      ],
    }),
  ]);

  it('lights the collections a caller actually moved', () => {
    const sel = { kind: 'caller' as const, name: 'run_dispatcher' };
    const sets = trafficSelectionSets(sel, callers);
    expect(sets.collections.has('run_queue')).toBe(true);
    // Listed against token_usage but with no counts — not a link.
    expect(sets.collections.has('token_usage')).toBe(false);
    expect(callerDimmed(sel, sets, 'run_dispatcher')).toBe(false);
    expect(callerDimmed(sel, sets, 'usage_ledger')).toBe(true);
  });

  it('lights the callers that moved a selected collection', () => {
    const sel = { kind: 'collection' as const, id: 'token_usage' };
    const sets = trafficSelectionSets(sel, callers);
    expect(sets.callers.has('usage_ledger')).toBe(true);
    expect(sets.callers.has('run_dispatcher')).toBe(false);
    expect(collectionDimmed(sel, sets, 'run_queue')).toBe(true);
  });

  it('dims nothing with no selection', () => {
    const sets = trafficSelectionSets(null, callers);
    expect(callerDimmed(null, sets, 'run_dispatcher')).toBe(false);
  });

  it('returns empty sets for a file selection, which this bank cannot show', () => {
    const sets = trafficSelectionSets({ kind: 'file', path: 'routes/money.py' }, callers);
    expect(sets.callers.size).toBe(0);
    expect(sets.collections.size).toBe(0);
  });
});

describe('sortedTouches', () => {
  it('orders a caller’s collections heaviest-write first, dropping empty ones', () => {
    const [c] = aggregateCallers([
      collection('a', 'json', { callers: [caller('x', { writes: 1 })] }),
      collection('b', 'json', { callers: [caller('x', { writes: 9 })] }),
      collection('c', 'json', { callers: [caller('x', { writes: 0, reads: 0 })] }),
    ]);
    expect(sortedTouches(c).map((t) => t.collection)).toEqual(['b', 'a']);
  });
});

describe('trafficCountLabel', () => {
  it('says the word quiet rather than a zero', () => {
    expect(trafficCountLabel(collection('budget', 'sql'), 'writes')).toBe('quiet');
  });

  it('reads a collection that was only read as quiet on the writes metric', () => {
    const c = collection('food_guide', 'json', { reads: 4 });
    expect(trafficCountLabel(c, 'writes')).toBe('quiet');
    expect(trafficCountLabel(c, 'reads')).toBe('4');
  });

  it('groups a big count so it stays readable', () => {
    expect(trafficCountLabel(collection('run_queue', 'json', { writes: 3333 }), 'writes')).toBe(
      (3333).toLocaleString(),
    );
  });
});

// --- the traffic window (1 / 7 / 30 days) ------------------------------------
// The counters keep ~33 days of per-day buckets, so a longer window costs a
// query parameter and nothing else. What it DOES cost is meaning: a 6-hour
// half-life over a month puts everything on the floor together, and the write
// journal can only timestamp what it has seen since it started. These cover
// both seams.

describe('halfLifeForWindow', () => {
  it('lands exactly on the tuned 6 hours for a one-day window', () => {
    expect(halfLifeForWindow(1)).toBe(FRESHNESS_HALF_LIFE_HOURS);
  });

  it('stretches with the window so a month doesn’t collapse onto the floor', () => {
    const now = new Date('2026-08-22T12:00:00');
    const tenDaysAgo = '2026-08-12T12:00:00';
    // On today's ramp a 10-day-old write is indistinguishable from ancient.
    expect(freshnessFactor(tenDaysAgo, now, halfLifeForWindow(1))).toBe(FRESHNESS_FLOOR);
    // On the 30-day ramp it still carries real signal.
    expect(freshnessFactor(tenDaysAgo, now, halfLifeForWindow(30))).toBeGreaterThan(
      FRESHNESS_FLOOR,
    );
  });

  it('never returns a zero or negative half-life, whatever it’s handed', () => {
    expect(halfLifeForWindow(0)).toBeGreaterThan(0);
    expect(halfLifeForWindow(-5)).toBeGreaterThan(0);
  });
});

describe('freshnessAt', () => {
  const now = new Date('2026-08-22T12:00:00');

  it('prefers the journal’s exact timestamp over the counters’ day', () => {
    const exact = freshnessAt(
      { last_write: '2026-08-22T11:00:00', last_write_day: '2026-08-01' },
      now,
    );
    expect(exact).toBeCloseTo(freshnessFactor('2026-08-22T11:00:00', now), 6);
  });

  it('falls back to the day when the journal has nothing', () => {
    const c = { last_write: null, last_write_day: '2026-08-21' };
    expect(freshnessAt(c, now)).toBeCloseTo(freshnessFactor('2026-08-21T00:00:00', now), 6);
  });

  it('reads a day as its MIDNIGHT, erring older rather than fresher', () => {
    // Today's date, but the day carries no clock — it must not be treated as
    // "just now". Overstating freshness is the one direction this may not err.
    const dayOnly = freshnessAt({ last_write: null, last_write_day: '2026-08-22' }, now);
    const rightNow = freshnessAt({ last_write: '2026-08-22T12:00:00', last_write_day: null }, now);
    expect(dayOnly).toBeLessThan(rightNow);
  });

  it('floors when it has no "when" at all', () => {
    expect(freshnessAt({ last_write: null, last_write_day: null }, now)).toBe(FRESHNESS_FLOOR);
  });
});

describe('writeState with a counter-derived day', () => {
  it('is "dated" when the counters know the day but the journal has no moment', () => {
    expect(writeState(12, null, '2026-08-09')).toBe('dated');
  });

  it('still prefers "moved" when an exact timestamp exists', () => {
    expect(writeState(12, '2026-08-21T22:30:00', '2026-08-21')).toBe('moved');
  });

  it('stays quiet on zero writes even with a day from an earlier window', () => {
    expect(writeState(0, null, '2026-08-09')).toBe('quiet');
  });

  it('keeps "timeless" for writes with no "when" from either source', () => {
    expect(writeState(12, null, null)).toBe('timeless');
  });

  it('fades a dated row by recency rather than pinning it full like timeless', () => {
    expect(trafficRowOpacity('dated', false, 0.7)).toBeCloseTo(0.7);
    expect(trafficRowOpacity('timeless', false, 0.7)).toBe(1);
  });
});

describe('relativeDay', () => {
  const now = new Date('2026-08-22T09:00:00');

  it('names today and yesterday', () => {
    expect(relativeDay('2026-08-22', now)).toBe('today');
    expect(relativeDay('2026-08-21', now)).toBe('yesterday');
  });

  it('prints an older day with no clock, since no clock was measured', () => {
    const out = relativeDay('2026-08-09', now);
    expect(out).toBe('Aug 9');
    expect(out).not.toMatch(/\d\d:\d\d/);
  });

  it('returns an unparseable value as-is rather than throwing', () => {
    expect(relativeDay('not-a-day', now)).toBe('not-a-day');
  });
});
