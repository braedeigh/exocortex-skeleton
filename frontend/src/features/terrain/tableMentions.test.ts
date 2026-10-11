import { describe, expect, it } from 'vitest';
import type { TerrainTable, TerrainTables } from './api';
import { callLinks, fileMentions, tableCodeLinks } from './tableMentions';
import { tableNodeId } from './tableNodes';

/**
 * tableMentions.test.ts — that the ropes between a table and its code only
 * reach dots that exist, that a file doing two things to one table is one
 * rope named by the louder of them, and that a file's mentions arrive as one
 * ascending list however the verbs split them up.
 */

function table(name: string, code: Partial<TerrainTable['code']> = {}): TerrainTable {
  return {
    name,
    rows: 10,
    bytes: 4096,
    index_bytes: 0,
    columns: [{ name: 'id', type: 'TEXT', notnull: false, pk: true }],
    indexes: [],
    foreign_keys: [],
    notes: null,
    code: { creates: [], writes: [], reads: [], ...code },
  };
}

function payload(tables: TerrainTable[]): TerrainTables {
  return { repo: 'vault', path: 'data/exo.db', code_repo: 'skeleton', tables };
}

describe('fileMentions', () => {
  it('merges one file across creates, writes and reads, ascending', () => {
    const todos = table('todos', {
      creates: [{ path: 'sqlstore.py', line: 4, lines: [4] }],
      writes: [{ path: 'sqlstore.py', line: 30, lines: [30, 12] }],
      reads: [{ path: 'sqlstore.py', line: 9, lines: [9, 30] }],
    });
    expect(fileMentions(todos, 'sqlstore.py')).toEqual([4, 9, 12, 30]);
  });

  it('ignores every other file', () => {
    const todos = table('todos', {
      reads: [
        { path: 'sqlstore.py', line: 9, lines: [9] },
        { path: 'routes/todos.py', line: 2, lines: [2, 7] },
      ],
    });
    expect(fileMentions(todos, 'routes/todos.py')).toEqual([2, 7]);
  });

  it('falls back to the one known line when the server sent no list', () => {
    const todos = table('todos', { reads: [{ path: 'sqlstore.py', line: 9 }] });
    expect(fileMentions(todos, 'sqlstore.py')).toEqual([9]);
  });
});

describe('tableCodeLinks', () => {
  const tableId = tableNodeId('vault', 'data/exo.db', 'todos');

  it('pairs a table with the files that touch it', () => {
    const tables = payload([table('todos', { reads: [{ path: 'routes/todos.py', line: 2 }] })]);
    const known = new Set([tableId, 'skeleton:file:routes/todos.py']);
    expect(tableCodeLinks(tables, known)).toEqual([
      { tableId, fileId: 'skeleton:file:routes/todos.py', verb: 'reads' },
    ]);
  });

  it('draws no rope to a file the dials cut off the map', () => {
    const tables = payload([table('todos', { reads: [{ path: 'routes/todos.py', line: 2 }] })]);
    expect(tableCodeLinks(tables, new Set([tableId]))).toEqual([]);
  });

  it('draws no rope from a table the map never placed', () => {
    const tables = payload([table('todos', { reads: [{ path: 'routes/todos.py', line: 2 }] })]);
    expect(tableCodeLinks(tables, new Set(['skeleton:file:routes/todos.py']))).toEqual([]);
  });

  it('makes one rope per pair, named by the strongest thing the file does', () => {
    const tables = payload([
      table('todos', {
        creates: [{ path: 'sqlstore.py', line: 4 }],
        writes: [{ path: 'sqlstore.py', line: 30 }],
        reads: [{ path: 'sqlstore.py', line: 9 }],
      }),
    ]);
    const known = new Set([tableId, 'skeleton:file:sqlstore.py']);
    expect(tableCodeLinks(tables, known)).toEqual([
      { tableId, fileId: 'skeleton:file:sqlstore.py', verb: 'creates' },
    ]);
  });

  it('has nothing to draw when the database sits outside both repos', () => {
    const tables: TerrainTables = { ...payload([table('todos')]), repo: null, path: null };
    expect(tableCodeLinks(tables, new Set(['skeleton:file:sqlstore.py']))).toEqual([]);
  });
});

describe('callLinks', () => {
  const page = 'skeleton:file:frontend/src/features/todos/TodosPage.tsx';
  const route = 'skeleton:file:routes/todos.py';
  const withCalls: TerrainTables = {
    ...payload([]),
    calls: [
      {
        path: 'frontend/src/features/todos/TodosPage.tsx',
        routes: [{ path: 'routes/todos.py', calls: ['/api/todos'] }],
      },
    ],
  };

  it('pairs a frontend file with the route module it calls', () => {
    expect(callLinks(withCalls, new Set([page, route]))).toEqual([{ pageId: page, routeId: route }]);
  });

  it('draws no rope to a route the dials cut off the map', () => {
    expect(callLinks(withCalls, new Set([page]))).toEqual([]);
  });

  it('has nothing to draw from a server that predates the calls', () => {
    expect(callLinks(payload([]), new Set([page, route]))).toEqual([]);
  });
});
