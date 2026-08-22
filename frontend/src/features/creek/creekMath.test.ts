import { describe, expect, it } from 'vitest';
import type { CreekCollection, CreekFile } from './api';
import {
  DIM_OPACITY,
  GROUP_GAP,
  HEADER_H,
  LEFT_X,
  LIT_READ_OPACITY,
  LIT_WRITE_OPACITY,
  MAX_STROKE,
  MIN_STROKE,
  READ_BASE_OPACITY,
  RIGHT_X,
  ROW_GAP,
  ROW_H,
  WRITE_BASE_OPACITY,
  buildRibbons,
  classifyDiffLine,
  codeHref,
  collectionDimmed,
  fileDimmed,
  fileReads,
  fileWrites,
  filesTouching,
  layoutCollections,
  layoutFiles,
  relativeDayTime,
  ribbonDimmed,
  ribbonOpacity,
  ribbonPathD,
  ribbonStrokeWidth,
  ribbonWeight,
  selectionSets,
  sortedCalls,
  sortedCallers,
  visibleRibbons,
} from './creekMath';

function file(path: string, area: CreekFile['area'], calls: CreekFile['calls']): CreekFile {
  return { path, area, calls };
}

function collection(
  id: string,
  backing: CreekCollection['backing'],
  over: Partial<CreekCollection> = {},
): CreekCollection {
  return { id, backing, reads: 0, writes: 0, callers: [], ...over };
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
});

describe('layoutCollections', () => {
  it('groups sql before json and sorts by writes descending', () => {
    const cols = [
      collection('cache', 'json', { writes: 1 }),
      collection('todos', 'sql', { writes: 5 }),
      collection('cards', 'sql', { writes: 9 }),
    ];
    const bank = layoutCollections(cols);
    expect(bank.headers.map((h) => h.key)).toEqual(['sql', 'json']);
    expect(bank.rows.map((r) => r.key)).toEqual(['cards', 'todos', 'cache']);
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

describe('ribbonOpacity', () => {
  it('dimmed always wins, regardless of kind or lit', () => {
    expect(ribbonOpacity('write', true, true)).toBe(DIM_OPACITY);
    expect(ribbonOpacity('read', true, false)).toBe(DIM_OPACITY);
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
    expect(write.file).toBe('routes/todos.py');
    expect(write.collection).toBe('todos');
    expect(write.count).toBe(2);
    expect(write.weight).toBeGreaterThan(0);

    const read = ribbons.find((r) => r.kind === 'read')!;
    expect(read.collection).toBe('cards');
    expect(read.count).toBe(1);

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
});

describe('visibleRibbons', () => {
  const ribbons = [
    { file: 'a', collection: 'b', kind: 'write' as const, count: 1, weight: 1, d: '' },
    { file: 'a', collection: 'b', kind: 'read' as const, count: 1, weight: 0, d: '' },
  ];

  it('drops read ribbons when the layer is off', () => {
    expect(visibleRibbons(ribbons, false)).toEqual([ribbons[0]]);
  });

  it('keeps everything when the layer is on', () => {
    expect(visibleRibbons(ribbons, true)).toHaveLength(2);
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
