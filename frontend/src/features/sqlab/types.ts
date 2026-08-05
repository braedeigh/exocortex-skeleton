/**
 * Shapes returned by routes/sqlab.py. `rows` is deliberately untyped cells —
 * the whole point is running arbitrary queries, so the column set isn't known
 * until the response comes back.
 */

export interface SqlColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
}

export interface SqlIndex {
  name: string;
  unique: boolean;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  indexes: SqlIndex[];
  rows: number;
}

export type SqlCell = string | number | boolean | null;

export interface SqlResult {
  columns: string[];
  rows: SqlCell[][];
  /** True when the server cut the result at `limit` — never hide this. */
  truncated: boolean;
  limit: number;
  ms: number;
  /** EXPLAIN QUERY PLAN steps: 'SCAN habits' vs 'SEARCH habits USING INDEX …'. */
  plan: string[];
}

/** One JSON-blob collection: a `docs` row, sized and classified. */
export interface Collection {
  name: string;
  /** log | registry | keyed | config | scalar | unreadable */
  kind: string;
  records: number;
  bytes: number;
  updated_at: string;
}

/** One typed table — real columns rather than a blob. */
export interface TypedTable {
  name: string;
  kind: 'table';
  records: number;
}
