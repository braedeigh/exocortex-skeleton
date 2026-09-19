/**
 * tableRows.ts — fetching a table's actual rows for the map's table window,
 * and the one piece of arithmetic the rows view needs (marking where a search
 * word appears in a cell).
 *
 * The map's table card (TerrainTableWindow.tsx) describes a table; its Rows
 * side (TerrainTableRows.tsx) shows what is actually IN it. Both doors are in
 * routes/terrain_tables.py:
 *
 *   /api/observatory/terrain/tables/rows   a page of rows, optionally only the
 *                                          ones containing a search word
 *   /api/observatory/terrain/tables/row    one row whole — cells in the list
 *                                          are cut short, this one isn't
 *
 * Its own file rather than more of api.ts: that file describes the map's
 * payloads, and this is a separate, owner-only conversation with the database.
 *
 * Prompt that produced it: "make it such that i can click into it to see the
 * actual rows themselves with a search function within the rows".
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** How many rows one page holds. The server allows up to 500; a hundred is
 * about what a person scans before they'd rather search. */
export const ROWS_PER_PAGE = 100;

export type TableCell = string | number | null;

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
  }[];
  /** Rows in the whole table. */
  total: number;
  /** Rows the search found — equal to `total` when there is no search. */
  matching: number;
  offset: number;
  limit: number;
  search: string;
}

export interface TableRowWhole {
  table: string;
  rowid: number;
  columns: string[];
  values: TableCell[];
}

/**
 * One page of a table's rows. The previous page stays on screen while the next
 * one loads (`keepPreviousData`), so typing in the search box or paging never
 * blanks the table — it just updates underneath her.
 */
export function useTableRows(table: string | null, search: string, page: number) {
  return useQuery({
    queryKey: ['terrain-table-rows', table, search, page] as const,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        table: table!,
        q: search,
        offset: String(page * ROWS_PER_PAGE),
        limit: String(ROWS_PER_PAGE),
      });
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
