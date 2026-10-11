/**
 * The builder composes SQL text from picked options — so these tests are just
 * "did the right clause come out, and did the unset ones stay away."
 *
 * The clause-omission cases matter most: a builder that emits `WHERE` with
 * nothing after it produces a syntax error, and a builder that silently drops a
 * clause you selected is worse than one that never offered it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, buildStatement, type BuilderSpec } from './builder';

const spec = (over: Partial<BuilderSpec>): BuilderSpec => ({ ...DEFAULT_SPEC, ...over });

describe('SELECT', () => {
  it('builds the minimal form', () => {
    expect(buildStatement(spec({ table: 'people' }))).toBe('SELECT *\nFROM people;');
  });

  it('omits every clause left blank', () => {
    const sql = buildStatement(spec({ table: 'people' }));
    for (const clause of ['WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'JOIN']) {
      expect(sql).not.toContain(clause);
    }
  });

  it('adds clauses in SQL order, not the order they were typed', () => {
    const sql = buildStatement(
      spec({
        table: 'people',
        columns: 'name, COUNT(*) AS n',
        limit: '5',
        where: 'age > 20',
        groupBy: 'name',
        orderBy: 'n DESC',
        having: 'COUNT(*) > 1',
      }),
    );
    const order = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT'];
    const positions = order.map((k) => sql.indexOf(k));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('takes an ON for a LEFT JOIN', () => {
    const sql = buildStatement(
      spec({ table: 'pets', joinKind: 'LEFT JOIN', joinTable: 'people', joinOn: 'people.id = pets.owner_id' }),
    );
    expect(sql).toContain('LEFT JOIN people ON people.id = pets.owner_id');
  });

  it('never puts an ON on a CROSS JOIN', () => {
    const sql = buildStatement(
      spec({ table: 'pets', joinKind: 'CROSS JOIN', joinTable: 'people', joinOn: 'ignored' }),
    );
    expect(sql).toContain('CROSS JOIN people');
    expect(sql).not.toContain('ON ');
  });

  it('quotes a table name that needs it', () => {
    expect(buildStatement(spec({ table: 'order' }))).toContain('FROM "order"');
  });
});

describe('INSERT conflict handling', () => {
  it('defaults to a plain insert', () => {
    const sql = buildStatement(spec({ kind: 'insert', table: 'people', columns: 'name', values: "'Ada'" }));
    expect(sql).toBe("INSERT INTO people (name)\nVALUES ('Ada');");
  });

  it('puts OR IGNORE before INTO', () => {
    const sql = buildStatement(
      spec({ kind: 'insert', table: 'people', columns: 'name', values: "'Ada'", conflict: 'OR IGNORE' }),
    );
    expect(sql).toContain('INSERT OR IGNORE INTO people');
  });

  it('builds an upsert with its target and SET', () => {
    const sql = buildStatement(
      spec({
        kind: 'insert',
        table: 'people',
        columns: 'name, email',
        values: "'Ada', 'ada@example.com'",
        conflict: 'ON CONFLICT DO UPDATE',
        conflictTarget: 'email',
        conflictSet: 'name = excluded.name',
      }),
    );
    expect(sql).toContain('ON CONFLICT (email) DO UPDATE SET name = excluded.name');
  });
});

describe('UPDATE and DELETE', () => {
  it('leaves WHERE off entirely when blank — the footgun stays visible', () => {
    const sql = buildStatement(spec({ kind: 'delete', table: 'people' }));
    expect(sql).toBe('DELETE FROM people;');
  });

  it('adds WHERE when given', () => {
    const sql = buildStatement(spec({ kind: 'update', table: 'people', setClause: 'age = 1', where: 'id = 2' }));
    expect(sql).toBe('UPDATE people\nSET age = 1\nWHERE id = 2;');
  });
});

describe('CREATE TABLE', () => {
  it('renders each constraint that was ticked', () => {
    const sql = buildStatement(
      spec({
        kind: 'create_table',
        table: 't',
        newColumns: [
          { name: 'id', type: 'INTEGER', pk: true, notNull: false, unique: false, check: '', defaultTo: '', references: '' },
          { name: 'email', type: 'TEXT', pk: false, notNull: true, unique: true, check: '', defaultTo: '', references: '' },
          { name: 'amount', type: 'INTEGER', pk: false, notNull: false, unique: false, check: 'amount > 0', defaultTo: '0', references: '' },
          { name: 'owner', type: 'INTEGER', pk: false, notNull: false, unique: false, check: '', defaultTo: '', references: 'people(id)' },
        ],
      }),
    );
    expect(sql).toContain('id INTEGER PRIMARY KEY');
    expect(sql).toContain('email TEXT NOT NULL UNIQUE');
    expect(sql).toContain('amount INTEGER DEFAULT 0 CHECK (amount > 0)');
    expect(sql).toContain('owner INTEGER REFERENCES people(id)');
  });

  it('does not repeat NOT NULL/UNIQUE on a primary key that already implies them', () => {
    const sql = buildStatement(
      spec({
        kind: 'create_table',
        table: 't',
        newColumns: [
          { name: 'id', type: 'INTEGER', pk: true, notNull: true, unique: true, check: '', defaultTo: '', references: '' },
        ],
      }),
    );
    expect(sql).toContain('id INTEGER PRIMARY KEY');
    expect(sql).not.toContain('NOT NULL');
    expect(sql).not.toContain('UNIQUE');
  });

  it('skips unnamed columns', () => {
    const sql = buildStatement(
      spec({
        kind: 'create_table',
        table: 't',
        newColumns: [
          { ...DEFAULT_SPEC.newColumns[0] },
          { name: '', type: 'TEXT', pk: false, notNull: false, unique: false, check: '', defaultTo: '', references: '' },
        ],
      }),
    );
    expect(sql.split('\n').filter((l) => l.startsWith('  '))).toHaveLength(1);
  });
});

describe('CREATE INDEX', () => {
  it('invents a readable name when none is given', () => {
    const sql = buildStatement(spec({ kind: 'create_index', table: 'big', indexColumns: 'category' }));
    expect(sql).toContain('CREATE INDEX idx_big_category');
    expect(sql).toContain('ON big (category)');
  });

  it('honours UNIQUE and IF NOT EXISTS', () => {
    const sql = buildStatement(
      spec({ kind: 'create_index', table: 'big', indexColumns: 'category', indexUnique: true, ifNotExists: true }),
    );
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
  });
});

describe('transaction wrapper', () => {
  it('wraps in BEGIN/ROLLBACK so a destructive statement can be tried safely', () => {
    const sql = buildStatement(spec({ kind: 'delete', table: 'people', wrap: 'rollback' }));
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql).toContain('DELETE FROM people;');
    expect(sql).toContain('ROLLBACK;');
  });

  it('wraps in BEGIN/COMMIT when the change should stick', () => {
    const sql = buildStatement(spec({ kind: 'delete', table: 'people', wrap: 'commit' }));
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toContain('ROLLBACK');
  });
});
