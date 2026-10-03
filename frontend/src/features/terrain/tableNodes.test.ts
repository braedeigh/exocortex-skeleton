import { describe, expect, it } from 'vitest';
import type {
  TerrainData,
  TerrainTable,
  TerrainTableActivity,
  TerrainTables,
  TerrainTablesActivity,
} from './api';
import { buildTerrainGraph } from './terrainGraph';
import {
  COLUMN_WIDTH,
  HEADER_HEIGHT,
  addTableNodes,
  describeTableShape,
  LONERS_LABEL,
  SHELF_MAX_WIDTH,
  corridorLeft,
  foreignKeyEdges,
  formatBytes,
  shelfLayout,
  tableFamilies,
  tableNodeId,
  tableSize,
  tablesPointingAt,
} from './tableNodes';

/**
 * tableNodes.test.ts — the arithmetic behind the map's table layer: that a
 * table's rectangle really is its shape, that tables land in the right folder
 * and survive being absent, that foreign keys become exactly the lines they
 * should, and that the plain-English shape names agree with the picture.
 */

function table(name: string, columnNames: string[], rows: number, extra: Partial<TerrainTable> = {}): TerrainTable {
  return {
    name,
    rows,
    bytes: 4096,
    index_bytes: 0,
    columns: columnNames.map((column, i) => ({ name: column, type: 'TEXT', notnull: false, pk: i === 0 })),
    indexes: [],
    foreign_keys: [],
    notes: null,
    code: { creates: [], writes: [], reads: [] },
    ...extra,
  };
}

const todos = table('todos', ['id', 'text', 'bucket', 'done'], 100);
const subtasks = table('todo_subtasks', ['id', 'todo_id', 'text'], 400, {
  foreign_keys: [{ column: 'todo_id', table: 'todos', to: 'id' }],
});

const payload: TerrainData = {
  generated_at: '2026-09-19T12:00:00',
  window_days: null,
  file_cap: null,
  repos: [
    { id: 'skeleton', name: 'App code', root: '/app', files: [], files_total: 0 },
    {
      id: 'vault',
      name: 'Personal vault',
      root: '/vault',
      files: [{ path: 'data/notes.md', touches: [1], sessions: [] }],
      files_total: 1,
    },
  ],
};

const described: TerrainTables = {
  repo: 'vault',
  path: 'data/exo.db',
  code_repo: 'skeleton',
  tables: [todos, subtasks],
};

describe('tableSize', () => {
  it('is one stripe wide per column', () => {
    expect(tableSize(todos).width).toBe(4 * COLUMN_WIDTH);
  });

  it('grows taller with more rows, by the square root', () => {
    const small = tableSize(table('a', ['id'], 100)).rowsHeight;
    const big = tableSize(table('b', ['id'], 400)).rowsHeight;
    expect(big).toBeCloseTo(small * 2);
  });

  it('draws an empty table as its header band alone', () => {
    const size = tableSize(table('empty', ['id', 'x'], 0));
    expect(size.rowsHeight).toBe(0);
    expect(size.height).toBe(HEADER_HEIGHT);
  });
});

describe('addTableNodes', () => {
  it('hangs each table under the database file, in the repo that holds it', () => {
    const out = addTableNodes(payload, described);
    const vault = out.repos.find((r) => r.id === 'vault')!;
    expect(vault.files.map((f) => f.path)).toEqual([
      'data/notes.md',
      'data/exo.db/todos',
      'data/exo.db/todo_subtasks',
    ]);
    expect(out.repos.find((r) => r.id === 'skeleton')!.files).toEqual([]);
  });

  it('leaves the payload alone when the database is outside every repo', () => {
    expect(addTableNodes(payload, { repo: null, path: null, code_repo: 'skeleton', tables: [todos] })).toBe(payload);
  });

  it('leaves the payload alone before the tables have loaded', () => {
    expect(addTableNodes(payload, undefined)).toBe(payload);
  });
});

describe('a table\'s history on the map', () => {
  // Built the way the page builds it: activity in, graph out, read at `now`.
  const now = 1_000_000;
  const hour = 3600;
  const withAgent: TerrainData = {
    ...payload,
    sessions: [{ id: 'agent-1', title: 'Builder', running: true, last: null }],
  };
  const graphFor = (tables: Record<string, Partial<TerrainTableActivity>>) => {
    const activity: TerrainTablesActivity = {
      recording_since: now - 24 * hour,
      tables: Object.fromEntries(
        Object.entries(tables).map(([name, seen]) => [
          name,
          { defined_at: null, migrated_at: null, rows_at: null, row_times: [], sessions: [], ...seen },
        ]),
      ),
    };
    return buildTerrainGraph(addTableNodes(withAgent, described, activity), hour, now, { runHalfLife: hour });
  };
  const node = (graph: ReturnType<typeof graphFor>, name: string) =>
    graph.nodes.find((n) => n.id === tableNodeId('vault', 'data/exo.db', name))!;

  it('lights red for a structure change and yellow for a row write, each on its own', () => {
    const graph = graphFor({ todos: { migrated_at: now }, todo_subtasks: { rows_at: now } });
    expect(node(graph, 'todos').heat).toBeCloseTo(1);
    expect(node(graph, 'todos').runHeat ?? 0).toBe(0);
    expect(node(graph, 'todo_subtasks').heat).toBe(0);
    expect(node(graph, 'todo_subtasks').runHeat).toBeCloseTo(1);
  });

  it('takes the later of the migration and the definition in code as the structure time', () => {
    const graph = graphFor({ todos: { defined_at: now - hour, migrated_at: now - 5 * hour } });
    expect(node(graph, 'todos').heat).toBeCloseTo(0.5);
  });

  it('gives a table with no recorded time no heat at all', () => {
    const graph = graphFor({ todos: {} });
    expect(node(graph, 'todos').heat).toBe(0);
    expect(node(graph, 'todos').runHeat ?? 0).toBe(0);
  });

  it('tethers the agent that wrote a table, without turning the table red', () => {
    const writer = { id: 'agent-1', writes: 3, last: now, structure: false };
    const stranger = { id: 'not-on-the-map', writes: 1, last: now, structure: false };
    const graph = graphFor({ todos: { rows_at: now, sessions: [writer, stranger] } });
    const tethers = graph.edges.filter((e) => e.kind === 'session');
    expect(tethers.map((e) => e.target)).toEqual([tableNodeId('vault', 'data/exo.db', 'todos')]);
    expect(node(graph, 'todos').heat).toBe(0);
  });
});

describe('foreign keys on the map', () => {
  const graph = buildTerrainGraph(addTableNodes(payload, described), 7 * 86400, 1000);

  it('draws one line from the table holding the key to the table it points at', () => {
    const keys = graph.edges.filter((e) => e.kind === 'fk');
    expect(keys).toEqual([
      {
        source: tableNodeId('vault', 'data/exo.db', 'todo_subtasks'),
        target: tableNodeId('vault', 'data/exo.db', 'todos'),
        kind: 'fk',
      },
    ]);
  });

  it('puts the tables under an exo.db folder', () => {
    const node = graph.nodes.find((n) => n.file?.table?.name === 'todos')!;
    const parent = graph.nodes.find((n) => n.id === node.parentId)!;
    expect(parent.kind).toBe('dir');
    expect(parent.label).toContain('exo.db');
  });

  it('skips a key to a missing table, and a table pointing at itself', () => {
    const habits = table('habits', ['id', 'merged_into', 'gone_id'], 5, {
      foreign_keys: [
        { column: 'merged_into', table: 'habits', to: 'id' },
        { column: 'gone_id', table: 'not_on_the_map', to: 'id' },
      ],
    });
    const alone = buildTerrainGraph(
      addTableNodes(payload, { repo: 'vault', path: 'data/exo.db', code_repo: 'skeleton', tables: [habits] }),
      7 * 86400,
      1000,
    );
    expect(foreignKeyEdges(alone.nodes)).toEqual([]);
  });
});

describe('tablesPointingAt', () => {
  it('finds the keys a table cannot see in its own definition', () => {
    expect(tablesPointingAt([todos, subtasks], 'todos')).toEqual([
      { table: 'todo_subtasks', column: 'todo_id' },
    ]);
  });
});

describe('describeTableShape', () => {
  it('calls a table with no rows empty', () => {
    expect(describeTableShape(table('t', ['id', 'x'], 0)).kind).toBe('empty');
  });

  it('calls a table whose every column is a foreign key a join table', () => {
    const join = table('todo_fronts', ['todo_id', 'front'], 167, {
      foreign_keys: [
        { column: 'todo_id', table: 'todos', to: 'id' },
        { column: 'front', table: 'fronts', to: 'id' },
      ],
    });
    expect(describeTableShape(join).kind).toBe('join');
  });

  it('calls few columns and many rows tall', () => {
    expect(describeTableShape(table('log', ['id', 'at'], 40000)).kind).toBe('tall');
  });

  it('calls many columns and few rows wide', () => {
    const wide = table('things', Array.from({ length: 20 }, (_, i) => `c${i}`), 30);
    expect(describeTableShape(wide).kind).toBe('wide');
  });
});

describe('formatBytes', () => {
  it('never reports an unmeasured size as zero', () => {
    expect(formatBytes(null)).toBe('not measured');
  });

  it('reads as a human size', () => {
    expect(formatBytes(2256896)).toBe('2.2 MB');
  });
});

describe('tableFamilies', () => {
  const fronts = table('fronts', ['id', 'name'], 15);
  const todoFronts = table('todo_fronts', ['todo_id', 'front'], 167, {
    foreign_keys: [
      { column: 'todo_id', table: 'todos', to: 'id' },
      { column: 'front', table: 'fronts', to: 'id' },
    ],
  });
  const docs = table('docs', ['name', 'data'], 44);
  const tags = table('tags', ['id', 'tag'], 900);
  const families = tableFamilies([docs, subtasks, fronts, tags, todoFronts, todos]);

  it('puts tables joined by foreign keys in one family, however they were listed', () => {
    expect(families[0].tables.map((t) => t.name).sort()).toEqual([
      'fronts',
      'todo_fronts',
      'todo_subtasks',
      'todos',
    ]);
  });

  it('names a family by the word most of its tables share', () => {
    expect(families[0].label).toBe('todo');
  });

  it('stands a parent before the tables that point at it', () => {
    const order = families[0].tables.map((t) => t.name);
    expect(order.indexOf('todos')).toBeLessThan(order.indexOf('todo_subtasks'));
    expect(order.indexOf('fronts')).toBeLessThan(order.indexOf('todo_fronts'));
  });

  it('gathers tables joined to nothing onto one last shelf, biggest first', () => {
    const last = families[families.length - 1];
    expect(last.label).toBe(LONERS_LABEL);
    expect(last.tables.map((t) => t.name)).toEqual(['tags', 'docs']);
  });

  it('does not let a key to itself make a table a family', () => {
    const habits = table('habits', ['id', 'merged_into'], 5, {
      foreign_keys: [{ column: 'merged_into', table: 'habits', to: 'id' }],
    });
    expect(tableFamilies([habits])[0].label).toBe(LONERS_LABEL);
  });
});

describe('shelfLayout', () => {
  it('stands every table on a shelf on the same baseline', () => {
    const layout = shelfLayout([todos, subtasks]);
    const bottoms = [todos, subtasks].map(
      (t) => layout.positions.get(t.name)!.y + tableSize(t).height / 2,
    );
    expect(bottoms[0]).toBeCloseTo(bottoms[1]);
    expect(layout.shelfLabels).toEqual([{ text: 'todo', x: 0, y: bottoms[0] }]);
  });

  it('never lets two tables share floor', () => {
    const layout = shelfLayout([todos, subtasks]);
    const a = layout.positions.get('todos')!;
    const b = layout.positions.get('todo_subtasks')!;
    const gap = Math.abs(a.x - b.x) - (tableSize(todos).width + tableSize(subtasks).width) / 2;
    expect(gap).toBeGreaterThan(0);
  });

  it('carries a family too long for one shelf onto the next one down', () => {
    const parent = table('things', ['id'], 10);
    const children = Array.from({ length: 12 }, (_, i) =>
      table(`thing_part_${i}`, ['id', 'thing_id'], 10 + i, {
        foreign_keys: [{ column: 'thing_id', table: 'things', to: 'id' }],
      }),
    );
    const layout = shelfLayout([parent, ...children]);
    const baselines = new Set(
      [parent, ...children].map((t) => Math.round(layout.positions.get(t.name)!.y + tableSize(t).height / 2)),
    );
    expect(baselines.size).toBeGreaterThan(1);
    expect(layout.width).toBeLessThanOrEqual(SHELF_MAX_WIDTH);
    expect(layout.shelfLabels).toHaveLength(1);
  });
});

/**
 * Where the section stands when it's between the two repos. The sign work is
 * the whole risk here: the same two measurements have to place the section in
 * the gap whichever side of the map the database's repo is on.
 */
describe('corridorLeft', () => {
  it('centres the section between the facing edges, others to the right', () => {
    // Own dots reach x = 100; the other repo starts at x = 500. Both are
    // already projected along inward = +1, which leaves them as they are.
    expect(corridorLeft(100, 500, 1, 200)).toBe(200); // centre 300, half-width 100
  });

  it('centres it the same way with the others to the LEFT', () => {
    // A mirror of the case above: own dots reach x = -100, the other repo
    // starts at x = -500, so projected along inward = -1 they read 100 and 500
    // again — and the section lands at the mirrored spot.
    expect(corridorLeft(100, 500, -1, 200)).toBe(-400); // centre -300
  });

  it('sits in an overlap rather than refusing it', () => {
    // The clusters start on top of each other, so the "gap" is inverted. The
    // section still gets a spot — the keep-out force is what parts them.
    expect(corridorLeft(600, 200, 1, 200)).toBe(300); // centre 400
  });
});
