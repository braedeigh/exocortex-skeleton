import { Fragment, useEffect, useState } from 'react';
import type { TerrainTable } from './api';
import { ROWS_PER_PAGE, splitOnMatch, useTableRow, useTableRows, type TableCell } from './tableRows';
import styles from './TerrainTableRows.module.css';

/**
 * TerrainTableRows — the Rows side of the map's table window: what is actually
 * IN the table, a page at a time, with a search box over it.
 *
 * The About side says a table has 2,773 rows and 13 columns; this is where
 * she sees them. It reads like a spreadsheet — her columns across the top, one
 * line per row — and it does three things:
 *
 *   SEARCH   one box. A row is kept if ANY of its columns contains the word
 *            (any case), numbers and dates included, and the word is lit up
 *            wherever it appears. The count above the table always says how
 *            many rows matched out of how many there are.
 *   PAGES    a hundred rows at a time, in the order the database stores them.
 *   OPEN     long values are cut short in the list (one journal card can be a
 *            page of text). Tapping a row opens it underneath itself with
 *            every value at full length, one field per line.
 *
 * Read-only, all of it: there is no way to change a row from here. Real
 * questions — sorting, joining, counting — belong to the SQL room.
 *
 * Fetching is tableRows.ts; the server side is routes/terrain_tables.py.
 * Shown inside TerrainTableWindow.tsx.
 *
 * Prompt that produced it: "make it such that i can click into it to see the
 * actual rows themselves with a search function within the rows".
 */

/** How long she has to stop typing before the search is sent. */
const SEARCH_PAUSE_MS = 250;

/** Show one cell's value as text: an empty database value says so, in words. */
function cellText(value: TableCell): string {
  return value === null ? 'NULL' : String(value);
}

/** One value, with the search word lit wherever it appears. */
function Marked({ value, word }: { value: TableCell; word: string }) {
  if (value === null) return <span className={styles.empty}>NULL</span>;
  return (
    <>
      {splitOnMatch(String(value), word).map((run, i) =>
        run.match ? (
          <mark key={i} className={styles.mark}>
            {run.text}
          </mark>
        ) : (
          <Fragment key={i}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

/** One opened row: every field on its own line, at full length. */
function WholeRow({ table, rowid, word, span }: { table: string; rowid: number; word: string; span: number }) {
  const whole = useTableRow(table, rowid);
  return (
    <tr className={styles.wholeRow}>
      <td colSpan={span}>
        {whole.data ? (
          <dl className={styles.fields}>
            {whole.data.columns.map((column, i) => (
              <div key={column} className={styles.field}>
                <dt className={styles.fieldName}>{column}</dt>
                <dd className={styles.fieldValue}>
                  <Marked value={whole.data.values[i]} word={word} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className={styles.status}>{whole.isError ? 'Could not read this row.' : 'Reading the whole row…'}</span>
        )}
      </td>
    </tr>
  );
}

export function TerrainTableRows({ table }: { table: TerrainTable }) {
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<number | null>(null);

  // Wait for a pause in typing before searching — this is a debounce. Each
  // keystroke restarts the clock, so "commit" sends one search, not six. A new
  // search also goes back to the first page and closes whatever row was open.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(typed.trim());
      setPage(0);
      setOpenRow(null);
    }, SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  // A different table is a fresh start: no leftover search, page or open row.
  useEffect(() => {
    setTyped('');
    setSearch('');
    setPage(0);
    setOpenRow(null);
  }, [table.name]);

  const rows = useTableRows(table.name, search, page);
  const data = rows.data;
  const primaryKeys = new Set(table.columns.filter((column) => column.pk).map((column) => column.name));
  const lastPage = data ? Math.max(0, Math.ceil(data.matching / ROWS_PER_PAGE) - 1) : 0;
  const firstShown = data && data.rows.length > 0 ? data.offset + 1 : 0;
  const lastShown = data ? data.offset + data.rows.length : 0;

  return (
    <div className={styles.rowsView}>
      <div className={styles.searchBar}>
        <input
          type="search"
          className={styles.search}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Search every column of ${table.name}…`}
          aria-label={`Search the rows of ${table.name}`}
        />
        {/* The count: always "how many matched, out of how many there are" —
            so an empty result reads as "0 of 2,773", never as an empty table. */}
        <span className={styles.count} aria-live="polite">
          {data
            ? search
              ? `${data.matching.toLocaleString()} of ${data.total.toLocaleString()} rows contain “${data.search}”`
              : `${data.total.toLocaleString()} rows`
            : rows.isError
              ? ''
              : 'Reading…'}
        </span>
      </div>

      {rows.isError ? (
        <p className={styles.status}>
          Could not read the rows. If the app was just updated, the server may need its reload before
          this door exists.
        </p>
      ) : null}

      {data && data.rows.length === 0 ? (
        <p className={styles.status}>
          {search ? 'No row contains that.' : 'This table is empty — it has columns, but nothing stored yet.'}
        </p>
      ) : null}

      {data && data.rows.length > 0 ? (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                {data.columns.map((column) => (
                  <th key={column} className={primaryKeys.has(column) ? styles.keyColumn : undefined}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const open = openRow === row.rowid;
                return (
                  <Fragment key={row.rowid}>
                    <tr
                      className={open ? styles.rowOpen : styles.row}
                      onClick={() => setOpenRow(open ? null : row.rowid)}
                      tabIndex={0}
                      role="button"
                      aria-expanded={open}
                      aria-label={`Row ${cellText(row.cells[0])} — ${open ? 'close' : 'open to see every value in full'}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setOpenRow(open ? null : row.rowid);
                        }
                      }}
                    >
                      {row.cells.map((cell, i) => (
                        <td key={i} className={typeof cell === 'number' ? styles.number : undefined}>
                          <div className={styles.cell}>
                            <Marked value={cell} word={search} />
                          </div>
                        </td>
                      ))}
                    </tr>
                    {open ? (
                      <WholeRow table={table.name} rowid={row.rowid} word={search} span={data.columns.length} />
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {data && data.matching > ROWS_PER_PAGE ? (
        <div className={styles.pager}>
          <button type="button" className={styles.pageBtn} disabled={page === 0} onClick={() => { setPage(page - 1); setOpenRow(null); }}>
            ‹ Earlier
          </button>
          <span className={styles.pageNote}>
            rows {firstShown.toLocaleString()}–{lastShown.toLocaleString()} of {data.matching.toLocaleString()}
          </span>
          <button type="button" className={styles.pageBtn} disabled={page >= lastPage} onClick={() => { setPage(page + 1); setOpenRow(null); }}>
            Later ›
          </button>
        </div>
      ) : null}

      <p className={styles.note}>
        In the order the database stores them. Long values are cut short here — tap a row to read it
        whole. Looking only: nothing can be changed from this view.
      </p>
    </div>
  );
}
