/**
 * tableRows.ts — everything the map's table window needs to LOOK THROUGH a
 * table: fetching its rows (searched, filtered, sorted), profiling one column,
 * and the small pieces of arithmetic behind the controls.
 *
 * The window's About side describes a table; its Rows side (TerrainTableRows)
 * shows what is actually in it. Three doors, all in routes/terrain_tables.py,
 * all read-only and owner-only:
 *
 *   /api/observatory/terrain/tables/rows    a page of rows. Takes a search
 *                                           word, a list of column filters,
 *                                           and a sort; sends back the SQL it
 *                                           ran, written out, so the page can
 *                                           show it.
 *   /api/observatory/terrain/tables/row     one row whole — cells in the list
 *                                           are cut short, this one isn't.
 *   /api/observatory/terrain/tables/column  one column profiled: how full it
 *                                           is, its values with their counts.
 *
 * A FILTER is a plain object — { column, op, value(s) } — where `op` is one
 * of a fixed list of words. The page never writes SQL; it sends words and the
 * server decides what they mean. The helpers below (toggleValue, withFilter,
 * describeFilter, nextSort…) are pure, so the rules of the controls are tested
 * (tableRows.test.ts) without a browser.
 *
 * Its own file rather than more of api.ts: that file describes the map's
 * payloads, and this is a separate, owner-only conversation with the database.
 *
 * Prompt that produced it: "make it such that i can click into it to see the
 * actual rows themselves with a search function within the rows" / "a more
 * robust feature to filter and sort the sql tables … toggle rows, sort by
 * oldest to newest and reverse the direction, and other things" / "see all the
 * value categories for a given [column] and a description of what [it]
 * contains for each one".
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { TerrainColumnNote } from './api';

/** How many rows one page holds. The server allows up to 500; a hundred is
 * about what a person scans before they'd rather filter. */
export const ROWS_PER_PAGE = 100;

export type TableCell = string | number | null;

/** What a filter may do to a column — the server's fixed list of words. */
export type TableFilterOp = 'is' | 'is_not' | 'contains' | 'empty' | 'not_empty' | 'min' | 'max';

export interface TableFilter {
  column: string;
  op: TableFilterOp;
  /** For 'is' / 'is_not': the values to keep or drop. null means "no value". */
  values?: TableCell[];
  /** For 'contains' / 'min' / 'max'. */
  value?: string | number;
}

export interface TableSort {
  column: string;
  descending: boolean;
}

/** Everything that decides which rows a page shows. */
export interface TableRowsQuery {
  search: string;
  filters: TableFilter[];
  sort: TableSort | null;
  page: number;
}

export interface TableRowsPage {
  table: string;
  columns: string[];
  rows: {
    /** SQLite's own hidden row number — the handle for fetching the row whole.
     * Not one of the table's columns. */
    rowid: number;
    cells: TableCell[];
    /** Parallel to `cells`: true where the server cut a long value short. */
    cut: boolean[];
    /** Parallel to `cells`, on a VISITOR's page only: true where this cell is
     * blocks rather than the value. Per CELL and not per column, because two
     * tables are decided per row — a skeleton commit's subject is readable
     * and a vault commit's is not, in the same column of the same page. */
    frosted?: boolean[];
  }[];
  /** Rows in the whole table. */
  total: number;
  /** Rows that passed the search and every filter — equal to `total` when
   * nothing is narrowing the table. */
  matching: number;
  offset: number;
  limit: number;
  search: string;
  /** The SQL that produced this page, with its values written in. Missing on
   * a server that predates it. */
  sql?: string;
  /** Set by the server for a VISITOR: true when ANY cell on this page came
   * back as blocks rather than a value (routes/terrain_tables.py). The view
   * reads this rather than guessing at who's looking — the data itself says
   * what it is. */
  frosted?: boolean;
  /** Columns that are blocks on every row of this table, for a visitor. */
  frosted_columns?: string[];
  /** Columns a visitor may not search, filter or sort on. WIDER than
   * `frosted_columns`: a column that is public on some rows and frosted on
   * others is readable but not askable, because a matching COUNT over it
   * would be a value read one bit at a time. */
  locked_columns?: string[];
}

export interface TableRowWhole {
  table: string;
  rowid: number;
  columns: string[];
  values: TableCell[];
  /** Set by the server for a VISITOR: true when any value came back as blocks. */
  frosted?: boolean;
  frosted_columns?: string[];
}

/** One column, profiled over the whole table. */
export interface TableColumnProfile {
  /** Set by the server for a VISITOR: the counts are real, the EXAMPLES are
   * gone — no smallest/largest/average and no value list, because those are
   * the column's contents (routes/terrain_tables.py `_frost_column`). The
   * card shows what the column is and drops the controls that would filter
   * or sort by it, since a frosted page ignores both. */
  frosted?: boolean;
  table: string;
  column: string;
  /** The declared SQLite type ('' when none). */
  type: string;
  primary_key: boolean;
  required: boolean;
  /** The table and column this one points at, when it's a foreign key. */
  points_at: { table: string; column: string | null } | null;
  /** The server's read of what kind of column this is, made from the data. */
  looks_like: 'yesno' | 'number' | 'date' | 'category' | 'text';
  total: number;
  filled: number;
  empty: number;
  distinct: number;
  smallest: TableCell;
  largest: TableCell;
  /** Numeric columns only. */
  average: number | null;
  /** True when the values are long text (a card's body) — then there is no
   * value list, because "the different values" of prose means nothing. */
  prose: boolean;
  /** The column's values with how many rows carry each, most common first:
   * all of them when `values_complete`, only the most common otherwise. */
  values: { value: TableCell; rows: number }[] | null;
  values_complete: boolean;
  notes: TerrainColumnNote | null;
}

/**
 * One page of a table's rows. The previous page stays on screen while the next
 * one loads (`keepPreviousData`), so typing, filtering, sorting or paging never
 * blanks the table — it just updates underneath her.
 */
export function useTableRows(table: string | null, query: TableRowsQuery) {
  const filters = JSON.stringify(query.filters);
  return useQuery({
    queryKey: ['terrain-table-rows', table, query.search, filters, query.sort?.column ?? null, query.sort?.descending ?? false, query.page] as const,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        table: table!,
        q: query.search,
        offset: String(query.page * ROWS_PER_PAGE),
        limit: String(ROWS_PER_PAGE),
      });
      if (query.filters.length > 0) params.set('filters', filters);
      if (query.sort) {
        params.set('sort', query.sort.column);
        params.set('dir', query.sort.descending ? 'desc' : 'asc');
      }
      return api.get<TableRowsPage>(`/api/observatory/terrain/tables/rows?${params}`, signal);
    },
    enabled: table !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** One row at full length — fetched only when she opens that row. */
export function useTableRow(table: string | null, rowid: number | null) {
  return useQuery({
    queryKey: ['terrain-table-row', table, rowid] as const,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ table: table!, rowid: String(rowid) });
      return api.get<TableRowWhole>(`/api/observatory/terrain/tables/row?${params}`, signal);
    },
    enabled: table !== null && rowid !== null,
    staleTime: 30_000,
  });
}

/** One column's profile — fetched only when she opens that column's card. */
export function useTableColumn(table: string | null, column: string | null) {
  return useQuery({
    queryKey: ['terrain-table-column', table, column] as const,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ table: table!, column: column! });
      return api.get<TableColumnProfile>(`/api/observatory/terrain/tables/column?${params}`, signal);
    },
    enabled: table !== null && column !== null,
    staleTime: 60_000,
  });
}

// --- the rules of the controls (pure) ------------------------------------------

/**
 * What a tap on a column's sort control does next: unsorted → ascending →
 * descending → unsorted. Three states on one button, so reversing the
 * direction and getting back to stored order are the same gesture repeated.
 * Tapping a DIFFERENT column always starts that column at ascending.
 */
export function nextSort(current: TableSort | null, column: string): TableSort | null {
  if (!current || current.column !== column) return { column, descending: false };
  if (!current.descending) return { column, descending: true };
  return null;
}

/** Put a filter in the list, replacing any filter of the same column AND kind
 * — a column can have a "from" and an "up to" at once, but not two "from"s. */
export function withFilter(filters: readonly TableFilter[], filter: TableFilter): TableFilter[] {
  return [...filters.filter((f) => !(f.column === filter.column && f.op === filter.op)), filter];
}

/** Take out one filter (by column and kind), or every filter on a column when
 * no kind is given. */
export function withoutFilter(
  filters: readonly TableFilter[],
  column: string,
  op?: TableFilterOp,
): TableFilter[] {
  return filters.filter((f) => !(f.column === column && (op === undefined || f.op === op)));
}

/**
 * Tap a value in a column's value list: add it to that column's "is" filter,
 * or take it out if it's already there. Taking out the last value removes the
 * filter altogether — an "is one of nothing" filter would hide every row.
 * An "is" filter and an "empty"/"not empty" filter on the same column would
 * contradict each other, so choosing a value clears those.
 */
export function toggleValue(
  filters: readonly TableFilter[],
  column: string,
  value: TableCell,
): TableFilter[] {
  const existing = filters.find((f) => f.column === column && f.op === 'is');
  const chosen = existing?.values ?? [];
  const next = chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value];
  const others = filters.filter(
    (f) => !(f.column === column && (f.op === 'is' || f.op === 'empty' || f.op === 'not_empty')),
  );
  return next.length === 0 ? others : [...others, { column, op: 'is', values: next }];
}

/** Whether a value is currently chosen in a column's "is" filter. */
export function valueIsChosen(filters: readonly TableFilter[], column: string, value: TableCell): boolean {
  return filters.some((f) => f.column === column && f.op === 'is' && (f.values ?? []).includes(value));
}

/** Say a filter in plain words, for its chip: "bucket is done or now",
 * "finished_on from 2026-08-01", "notes is empty". */
export function describeFilter(filter: TableFilter): string {
  const shown = (value: TableCell) => (value === null ? 'empty' : String(value));
  switch (filter.op) {
    case 'is':
      return `${filter.column} is ${(filter.values ?? []).map(shown).join(' or ')}`;
    case 'is_not':
      return `${filter.column} is not ${(filter.values ?? []).map(shown).join(' or ')}`;
    case 'contains':
      return `${filter.column} contains “${filter.value}”`;
    case 'empty':
      return `${filter.column} is empty`;
    case 'not_empty':
      return `${filter.column} is filled in`;
    case 'min':
      return `${filter.column} from ${filter.value}`;
    case 'max':
      return `${filter.column} up to ${filter.value}`;
  }
}

/** The day `days` days before `today`, as YYYY-MM-DD in LOCAL time — the form
 * the dates in these tables are written in. `today` is injectable for tests. */
export function daysAgo(days: number, today: Date = new Date()): string {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

// --- which columns are hidden, remembered per table ------------------------------

const HIDDEN_KEY = 'terrain_table_hidden_columns';

/** The columns she has hidden in one table. Kept in the browser's storage, per
 * table, so the twelve columns of `todos` she never reads stay out of the way
 * next time too. Unreadable storage just means nothing is hidden. */
export function loadHiddenColumns(table: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, unknown>;
    const hidden = all[table];
    return Array.isArray(hidden) ? hidden.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHiddenColumns(table: string, hidden: readonly string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, unknown>;
    if (hidden.length === 0) delete all[table];
    else all[table] = [...hidden];
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(all));
  } catch {
    /* no storage — the choice lasts until the window closes */
  }
}

/**
 * Split a piece of text into runs that match the search word and runs that
 * don't, in order, so the view can wrap the matching runs in a highlight.
 *
 * Any-case, like the server's search, and literal — the word is looked for as
 * typed, never treated as a pattern. No word, or no match, gives the text back
 * as one plain run.
 */
export function splitOnMatch(text: string, word: string): { text: string; match: boolean }[] {
  if (!word || !text) return [{ text, match: false }];
  const runs: { text: string; match: boolean }[] = [];
  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) runs.push({ text: text.slice(from, at), match: false });
    runs.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), match: false });
  return runs.length > 0 ? runs : [{ text, match: false }];
}
