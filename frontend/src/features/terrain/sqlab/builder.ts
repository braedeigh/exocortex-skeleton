/**
 * Composes SQL text from a set of picked options.
 *
 * The point isn't to save typing — it's that **the options are the syllabus**.
 * Seeing INNER / LEFT / CROSS sitting in a dropdown together, or the four
 * different ON CONFLICT behaviours listed side by side, tells you what SQL
 * actually offers. You can't look up a clause you don't know exists.
 *
 * It writes into the editor rather than replacing it, so the composed statement
 * is a starting point you then edit by hand. Nothing here can express every
 * query — that's fine, and finding its edges is part of the point.
 *
 * Pure string-building on purpose: no database, no React, so it's unit-tested
 * directly (builder.test.ts).
 */

export type StatementKind =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'create_table'
  | 'create_index'
  | 'drop_table';

export const STATEMENT_LABELS: Record<StatementKind, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  create_table: 'CREATE TABLE',
  create_index: 'CREATE INDEX',
  drop_table: 'DROP TABLE',
};

export type JoinKind = 'none' | 'INNER JOIN' | 'LEFT JOIN' | 'CROSS JOIN';

/** The four ways INSERT can meet a row that's already there. */
export type ConflictKind = 'none' | 'OR IGNORE' | 'OR REPLACE' | 'ON CONFLICT DO UPDATE';

/** Wrap the statement in a transaction that either keeps or discards the work. */
export type WrapKind = 'none' | 'commit' | 'rollback';

export interface ColumnSpec {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
  unique: boolean;
  /** Raw CHECK expression, e.g. "amount > 0". Empty = no check. */
  check: string;
  /** Raw DEFAULT expression. Empty = none. */
  defaultTo: string;
  /** "people(id)" — empty = not a foreign key. */
  references: string;
}

export interface BuilderSpec {
  kind: StatementKind;
  table: string;
  columns: string;
  distinct: boolean;
  where: string;
  joinKind: JoinKind;
  joinTable: string;
  joinOn: string;
  groupBy: string;
  having: string;
  orderBy: string;
  limit: string;
  values: string;
  conflict: ConflictKind;
  conflictTarget: string;
  conflictSet: string;
  setClause: string;
  newColumns: ColumnSpec[];
  indexName: string;
  indexColumns: string;
  indexUnique: boolean;
  ifNotExists: boolean;
  wrap: WrapKind;
}

export const EMPTY_COLUMN: ColumnSpec = {
  name: '',
  type: 'TEXT',
  pk: false,
  notNull: false,
  unique: false,
  check: '',
  defaultTo: '',
  references: '',
};

export const DEFAULT_SPEC: BuilderSpec = {
  kind: 'select',
  table: '',
  columns: '*',
  distinct: false,
  where: '',
  joinKind: 'none',
  joinTable: '',
  joinOn: '',
  groupBy: '',
  having: '',
  orderBy: '',
  limit: '',
  values: '',
  conflict: 'none',
  conflictTarget: '',
  conflictSet: '',
  setClause: '',
  newColumns: [{ ...EMPTY_COLUMN, name: 'id', type: 'INTEGER', pk: true }],
  indexName: '',
  indexColumns: '',
  indexUnique: false,
  ifNotExists: false,
  wrap: 'none',
};

/**
 * SQLite keywords that are plausible table or column names. These LOOK like
 * ordinary identifiers, so a shape check alone waves them through and emits
 * `FROM order`, which is a syntax error. Quoting is the fix, and it's also the
 * honest lesson: this is why `"order"` shows up in real schemas.
 */
const RESERVED = new Set([
  'abort', 'action', 'add', 'after', 'all', 'alter', 'analyze', 'and', 'as', 'asc',
  'attach', 'before', 'begin', 'between', 'by', 'cascade', 'case', 'cast', 'check',
  'collate', 'column', 'commit', 'conflict', 'constraint', 'create', 'cross',
  'current', 'default', 'deferrable', 'deferred', 'delete', 'desc', 'detach',
  'distinct', 'do', 'drop', 'each', 'else', 'end', 'escape', 'except', 'exclude',
  'exclusive', 'exists', 'explain', 'fail', 'filter', 'first', 'following', 'for',
  'foreign', 'from', 'full', 'glob', 'group', 'groups', 'having', 'if', 'ignore',
  'immediate', 'in', 'index', 'indexed', 'initially', 'inner', 'insert', 'instead',
  'intersect', 'into', 'is', 'isnull', 'join', 'key', 'last', 'left', 'like',
  'limit', 'match', 'natural', 'no', 'not', 'nothing', 'notnull', 'null', 'nulls',
  'of', 'offset', 'on', 'or', 'order', 'others', 'outer', 'over', 'partition',
  'plan', 'pragma', 'preceding', 'primary', 'query', 'raise', 'range', 'recursive',
  'references', 'regexp', 'reindex', 'release', 'rename', 'replace', 'restrict',
  'returning', 'right', 'rollback', 'row', 'rows', 'savepoint', 'select', 'set',
  'table', 'temp', 'temporary', 'then', 'ties', 'to', 'transaction', 'trigger',
  'unbounded', 'union', 'unique', 'update', 'using', 'vacuum', 'values', 'view',
  'virtual', 'when', 'where', 'window', 'with', 'without',
]);

const q = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase())
    ? name
    : `"${name}"`;

function columnDdl(col: ColumnSpec): string {
  const parts = [q(col.name), col.type];
  if (col.pk) parts.push('PRIMARY KEY');
  if (col.notNull && !col.pk) parts.push('NOT NULL');
  if (col.unique && !col.pk) parts.push('UNIQUE');
  if (col.defaultTo.trim()) parts.push(`DEFAULT ${col.defaultTo.trim()}`);
  if (col.check.trim()) parts.push(`CHECK (${col.check.trim()})`);
  if (col.references.trim()) parts.push(`REFERENCES ${col.references.trim()}`);
  return parts.join(' ');
}

function buildSelect(s: BuilderSpec): string {
  const lines = [`SELECT ${s.distinct ? 'DISTINCT ' : ''}${s.columns.trim() || '*'}`];
  lines.push(`FROM ${q(s.table)}`);
  if (s.joinKind !== 'none' && s.joinTable.trim()) {
    // CROSS JOIN pairs every row with every row and takes no ON — that's the
    // whole idea of it, so omitting the clause here is correct, not a gap.
    const on = s.joinKind === 'CROSS JOIN' || !s.joinOn.trim() ? '' : ` ON ${s.joinOn.trim()}`;
    lines.push(`${s.joinKind} ${q(s.joinTable.trim())}${on}`);
  }
  if (s.where.trim()) lines.push(`WHERE ${s.where.trim()}`);
  if (s.groupBy.trim()) lines.push(`GROUP BY ${s.groupBy.trim()}`);
  if (s.having.trim()) lines.push(`HAVING ${s.having.trim()}`);
  if (s.orderBy.trim()) lines.push(`ORDER BY ${s.orderBy.trim()}`);
  if (s.limit.trim()) lines.push(`LIMIT ${s.limit.trim()}`);
  return lines.join('\n');
}

function buildInsert(s: BuilderSpec): string {
  const or = s.conflict === 'OR IGNORE' || s.conflict === 'OR REPLACE' ? ` ${s.conflict}` : '';
  const cols = s.columns.trim() && s.columns.trim() !== '*' ? ` (${s.columns.trim()})` : '';
  let sql = `INSERT${or} INTO ${q(s.table)}${cols}\nVALUES (${s.values.trim()})`;
  if (s.conflict === 'ON CONFLICT DO UPDATE') {
    const target = s.conflictTarget.trim() ? ` (${s.conflictTarget.trim()})` : '';
    const set = s.conflictSet.trim() || 'column = excluded.column';
    sql += `\nON CONFLICT${target} DO UPDATE SET ${set}`;
  }
  return sql;
}

function buildBody(s: BuilderSpec): string {
  switch (s.kind) {
    case 'select':
      return buildSelect(s);
    case 'insert':
      return buildInsert(s);
    case 'update': {
      const where = s.where.trim() ? `\nWHERE ${s.where.trim()}` : '';
      return `UPDATE ${q(s.table)}\nSET ${s.setClause.trim() || 'column = value'}${where}`;
    }
    case 'delete': {
      const where = s.where.trim() ? `\nWHERE ${s.where.trim()}` : '';
      return `DELETE FROM ${q(s.table)}${where}`;
    }
    case 'create_table': {
      const cols = s.newColumns.filter((c) => c.name.trim()).map(columnDdl);
      const body = cols.length ? cols.map((c) => `  ${c}`).join(',\n') : '  id INTEGER PRIMARY KEY';
      const guard = s.ifNotExists ? 'IF NOT EXISTS ' : '';
      return `CREATE TABLE ${guard}${q(s.table)} (\n${body}\n)`;
    }
    case 'create_index': {
      const unique = s.indexUnique ? 'UNIQUE ' : '';
      const guard = s.ifNotExists ? 'IF NOT EXISTS ' : '';
      const name = s.indexName.trim() || `idx_${s.table || 'table'}_${(s.indexColumns || 'col').replace(/\W+/g, '_')}`;
      return `CREATE ${unique}INDEX ${guard}${q(name)}\nON ${q(s.table)} (${s.indexColumns.trim() || 'column'})`;
    }
    case 'drop_table':
      return `DROP TABLE ${s.ifNotExists ? 'IF EXISTS ' : ''}${q(s.table)}`;
  }
}

/**
 * The finished statement. A `wrap` of 'rollback' is the safe way to try a
 * destructive statement: it runs, you see what it would have changed, and then
 * it's undone.
 */
export function buildStatement(spec: BuilderSpec): string {
  const body = buildBody(spec);
  if (spec.wrap === 'none') return `${body};`;
  const closer = spec.wrap === 'commit' ? 'COMMIT' : 'ROLLBACK';
  const note =
    spec.wrap === 'rollback'
      ? '\n-- ROLLBACK undoes it: run it, see the damage, keep the data.'
      : '';
  return `BEGIN;\n${body};\n${closer};${note}`;
}

/** Which option groups apply to a statement kind — drives what the UI shows. */
export function relevantOptions(kind: StatementKind): string[] {
  switch (kind) {
    case 'select':
      return ['columns', 'distinct', 'join', 'where', 'groupBy', 'having', 'orderBy', 'limit'];
    case 'insert':
      return ['columns', 'values', 'conflict'];
    case 'update':
      return ['set', 'where'];
    case 'delete':
      return ['where'];
    case 'create_table':
      return ['newColumns', 'ifNotExists'];
    case 'create_index':
      return ['indexName', 'indexColumns', 'indexUnique', 'ifNotExists'];
    case 'drop_table':
      return ['ifNotExists'];
  }
}
