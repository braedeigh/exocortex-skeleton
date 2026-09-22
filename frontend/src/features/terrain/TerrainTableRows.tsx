import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { handQueryToSqlRoom } from '../sqlab/handoff';
import type { TerrainTable } from './api';
import { tablesPointingAt } from './tableNodes';
import { TerrainColumnCard } from './TerrainColumnCard';
import {
  ROWS_PER_PAGE,
  describeFilter,
  loadHiddenColumns,
  nextSort,
  saveHiddenColumns,
  splitOnMatch,
  useTableRow,
  useTableRows,
  withoutFilter,
  type TableCell,
  type TableFilter,
  type TableSort,
} from './tableRows';
import styles from './TerrainTableRows.module.css';

/**
 * TerrainTableRows — the Rows side of the map's table window: what is actually
 * IN the table, and the tools for looking through it.
 *
 * The About side says a table has 282 rows and 22 columns; this is where she
 * sees them and works with them. It reads like a spreadsheet — her columns
 * across the top, one line per row. From the top of the view down:
 *
 *   SEARCH        one box. A row is kept if ANY column contains the word (any
 *                 case), numbers and dates included; the word is lit up
 *                 wherever it appears.
 *   NEWEST FIRST  one button that sorts by the table's TIME column — declared
 *                 per table in table_notes.json, never guessed — and reverses
 *                 on a second tap. Absent on tables with no time column.
 *   COLUMNS       show or hide any column; the choice is remembered per table.
 *   FILTER CHIPS  every filter in force, in words ("bucket is done"), each
 *                 with an × — and the count, always "41 of 282", so an empty
 *                 result can't be mistaken for an empty table.
 *   THE TABLE     a column's NAME opens that column's card (TerrainColumnCard:
 *                 what it holds, its values, and the filters that suit it);
 *                 the ARROW beside the name sorts by it — up, down, off.
 *   AN OPEN ROW   tapping a row opens it underneath itself with every value at
 *                 full length. A value that points into another table is a
 *                 button that goes to that row; and "rows that point here"
 *                 lists the other tables' rows that belong to this one.
 *   THE SQL       the statement her taps have built, written out, with a door
 *                 into the SQL room where it can be changed and run. The
 *                 server has to build it anyway; showing it is how the taps
 *                 teach the language.
 *
 * Read-only, all of it: there is no way to change a row from here.
 *
 * State that lives here: the search, the filters, the sort, the page, which
 * row and which column are open, and which columns are hidden. `start` lets
 * the window open this view already filtered — that's how following a join
 * lands on exactly the row it pointed at. Fetching and the rules of the
 * controls are tableRows.ts; the server side is routes/terrain_tables.py.
 *
 * Prompt that produced it: "make it such that i can click into it to see the
 * actual rows themselves with a search function within the rows" / "a more
 * robust feature to filter and sort the sql tables when i look at all of the
 * rows and columns. i want to be able to toggle rows, sort by oldest to newest
 * and reverse the direction, and other things".
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

/** Where to go, and already filtered how, when a join is followed. */
export interface TableJump {
  table: string;
  filters: TableFilter[];
}

/**
 * One opened row: every field on its own line, at full length — and the joins.
 *
 * A field that is a foreign key gets a button to the row it points at. Under
 * the fields, "rows that point here" lists each table holding a key to THIS
 * table, as a button that opens those rows — the direction a table can't see
 * in its own definition. Only offered when the pointed-at column is part of
 * this row (it nearly always is: keys point at ids).
 */
function WholeRow({
  table,
  allTables,
  rowid,
  word,
  span,
  onJump,
}: {
  table: TerrainTable;
  allTables: readonly TerrainTable[];
  rowid: number;
  word: string;
  span: number;
  onJump: (jump: TableJump) => void;
}) {
  const whole = useTableRow(table.name, rowid);
  const pointsAt = new Map(table.foreign_keys.map((key) => [key.column, key]));
  const data = whole.data;
  const valueOf = (column: string): TableCell =>
    data ? (data.values[data.columns.indexOf(column)] ?? null) : null;

  // The other tables' keys that point at this table, each resolved to the
  // value in THIS row they'd have to match.
  const pointedAtBy = data
    ? tablesPointingAt(allTables, table.name).flatMap((other) => {
        const key = allTables
          .find((t) => t.name === other.table)
          ?.foreign_keys.find((k) => k.column === other.column && k.table === table.name);
        const target = key?.to ?? table.columns.find((c) => c.pk)?.name;
        const value = target ? valueOf(target) : null;
        return value === null ? [] : [{ ...other, value }];
      })
    : [];

  return (
    <tr className={styles.wholeRow}>
      <td colSpan={span}>
        {data ? (
          <div className={styles.fields}>
            <dl className={styles.fieldList}>
              {data.columns.map((column, i) => {
                const key = pointsAt.get(column);
                const value = data.values[i];
                return (
                  <div key={column} className={styles.field}>
                    <dt className={styles.fieldName}>{column}</dt>
                    <dd className={styles.fieldValue}>
                      <Marked value={value} word={word} />
                      {key && value !== null && key.table !== table.name ? (
                        <button
                          type="button"
                          className={styles.jump}
                          onClick={() =>
                            onJump({
                              table: key.table,
                              filters: [
                                {
                                  column: key.to ?? allTables.find((t) => t.name === key.table)?.columns.find((c) => c.pk)?.name ?? 'id',
                                  op: 'is',
                                  values: [value],
                                },
                              ],
                            })
                          }
                        >
                          → this row in {key.table}
                        </button>
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {pointedAtBy.length > 0 ? (
              <div className={styles.pointedAt}>
                <span className={styles.pointedAtLabel}>Rows that point here</span>
                {pointedAtBy.map((other) => (
                  <button
                    key={`${other.table}:${other.column}`}
                    type="button"
                    className={styles.jump}
                    onClick={() =>
                      onJump({
                        table: other.table,
                        filters: [{ column: other.column, op: 'is', values: [other.value] }],
                      })
                    }
                  >
                    {other.table} where {other.column} is {cellText(other.value)} →
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <span className={styles.status}>{whole.isError ? 'Could not read this row.' : 'Reading the whole row…'}</span>
        )}
      </td>
    </tr>
  );
}

export function TerrainTableRows({
  table,
  allTables,
  start,
  onJump,
}: {
  table: TerrainTable;
  allTables: readonly TerrainTable[];
  /** Filters to open with — set when a join was followed here. */
  start: TableFilter[] | null;
  onJump: (jump: TableJump) => void;
}) {
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<TableFilter[]>(start ?? []);
  const [sort, setSort] = useState<TableSort | null>(null);
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [openColumn, setOpenColumn] = useState<string | null>(null);
  const [choosingColumns, setChoosingColumns] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [hidden, setHidden] = useState<string[]>(() => loadHiddenColumns(table.name));

  // Wait for a pause in typing before searching — this is a debounce. Each
  // keystroke restarts the clock, so "commit" sends one search, not six.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typed.trim()), SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  // A different table — or the same table reached by following a join — is a
  // fresh start: its own filters, no leftover search, sort, page or open row.
  useEffect(() => {
    setTyped('');
    setSearch('');
    setFilters(start ?? []);
    setSort(null);
    setPage(0);
    setOpenRow(null);
    setOpenColumn(null);
    setChoosingColumns(false);
    setHidden(loadHiddenColumns(table.name));
  }, [table.name, start]);

  // Anything that changes WHICH rows are shown goes back to the first page and
  // closes the open row — page 3 of a different result is a meaningless place.
  const narrowing = JSON.stringify([search, filters, sort]);
  useEffect(() => {
    setPage(0);
    setOpenRow(null);
  }, [narrowing]);

  const rows = useTableRows(table.name, { search, filters, sort, page });
  const data = rows.data;
  const timeColumn = table.notes?.time_column ?? null;
  const primaryKeys = useMemo(
    () => new Set(table.columns.filter((column) => column.pk).map((column) => column.name)),
    [table.columns],
  );
  const lastPage = data ? Math.max(0, Math.ceil(data.matching / ROWS_PER_PAGE) - 1) : 0;
  const firstShown = data && data.rows.length > 0 ? data.offset + 1 : 0;
  const lastShown = data ? data.offset + data.rows.length : 0;
  const narrowed = search !== '' || filters.length > 0;
  // A frosted page is a visitor's: the cells are shapes, and the server
  // ignores search, filters and sort on one — so the controls that drive them
  // are hidden rather than left to do nothing.
  const frosted = data?.frosted === true;

  // Which of the server's columns to draw, by position — the cells arrive in
  // column order, so hiding a column means skipping its index in every row.
  const shownIndexes = data
    ? data.columns.map((_, i) => i).filter((i) => !hidden.includes(data.columns[i]))
    : [];

  const setHiddenColumns = (next: string[]) => {
    setHidden(next);
    saveHiddenColumns(table.name, next);
  };
  const toggleHidden = (column: string) =>
    setHiddenColumns(hidden.includes(column) ? hidden.filter((c) => c !== column) : [...hidden, column]);

  const newestFirst = sort?.column === timeColumn && sort?.descending === true;
  const oldestFirst = sort?.column === timeColumn && sort?.descending === false;

  return (
    <div className={styles.rowsView}>
      {/* SEARCH, NEWEST FIRST, COLUMNS */}
      <div className={styles.toolbar}>
        {frosted ? (
          <span className={styles.frostedNote}>
            Values hidden — each cell is the shape of what's really there
          </span>
        ) : (
          <input
            type="search"
            className={styles.search}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Search every column of ${table.name}…`}
            aria-label={`Search the rows of ${table.name}`}
          />
        )}
        {timeColumn && !frosted ? (
          // One button, three states: newest first → oldest first → stored
          // order. It says what it's CURRENTLY doing, and by which column.
          <button
            type="button"
            className={newestFirst || oldestFirst ? styles.toolOn : styles.tool}
            onClick={() =>
              setSort(newestFirst ? { column: timeColumn, descending: false } : oldestFirst ? null : { column: timeColumn, descending: true })
            }
            title={`Sorts by ${timeColumn}, this table's time column`}
          >
            {newestFirst ? `Newest first ↓` : oldestFirst ? `Oldest first ↑` : `Newest first`}
          </button>
        ) : null}
        <button
          type="button"
          className={choosingColumns ? styles.toolOn : styles.tool}
          aria-expanded={choosingColumns}
          onClick={() => setChoosingColumns(!choosingColumns)}
        >
          Columns · {table.columns.length - hidden.filter((c) => table.columns.some((col) => col.name === c)).length} of{' '}
          {table.columns.length}
        </button>
      </div>

      {/* COLUMNS — show or hide each one. */}
      {choosingColumns ? (
        <div className={styles.columnChooser}>
          <div className={styles.chooserHead}>
            <span className={styles.chooserTitle}>Tap a column to hide or show it</span>
            {hidden.length > 0 ? (
              <button type="button" className={styles.linkButton} onClick={() => setHiddenColumns([])}>
                Show all
              </button>
            ) : null}
          </div>
          <div className={styles.chips}>
            {table.columns.map((column) => {
              const on = !hidden.includes(column.name);
              return (
                <button
                  key={column.name}
                  type="button"
                  className={on ? styles.columnChipOn : styles.columnChip}
                  aria-pressed={on}
                  onClick={() => toggleHidden(column.name)}
                >
                  {column.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* FILTER CHIPS and THE COUNT */}
      <div className={styles.summary}>
        <span className={styles.count} aria-live="polite">
          {data
            ? narrowed
              ? `${data.matching.toLocaleString()} of ${data.total.toLocaleString()} rows`
              : `${data.total.toLocaleString()} rows`
            : rows.isError
              ? ''
              : 'Reading…'}
          {sort
            ? // The time column gets time words; any other column gets the
              // neutral pair, which is true of numbers, dates and text alike.
              ` · sorted by ${sort.column}, ${
                sort.column === timeColumn
                  ? sort.descending
                    ? 'newest first'
                    : 'oldest first'
                  : sort.descending
                    ? 'high to low'
                    : 'low to high'
              }`
            : ''}
        </span>
        {search ? (
          <button type="button" className={styles.filterChip} onClick={() => setTyped('')}>
            any column contains “{search}” <span aria-hidden="true">×</span>
          </button>
        ) : null}
        {filters.map((filter) => (
          <button
            key={`${filter.column}:${filter.op}`}
            type="button"
            className={styles.filterChip}
            aria-label={`Remove the filter: ${describeFilter(filter)}`}
            onClick={() => setFilters(withoutFilter(filters, filter.column, filter.op))}
          >
            {describeFilter(filter)} <span aria-hidden="true">×</span>
          </button>
        ))}
        {filters.length + (search ? 1 : 0) > 1 ? (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setFilters([]);
              setTyped('');
            }}
          >
            Clear all
          </button>
        ) : null}
      </div>

      {/* THE COLUMN CARD — opened by tapping a column's name below. */}
      {openColumn ? (
        <TerrainColumnCard
          key={`${table.name}:${openColumn}`}
          table={table.name}
          column={openColumn}
          filters={filters}
          sort={sort}
          onFilters={setFilters}
          onSort={setSort}
          onHide={() => {
            toggleHidden(openColumn);
            setOpenColumn(null);
          }}
          onClose={() => setOpenColumn(null)}
        />
      ) : null}

      {rows.isError ? (
        <p className={styles.status}>
          Could not read the rows. If the app was just updated, the server may need its reload before
          this door exists.
        </p>
      ) : null}

      {data && data.rows.length === 0 ? (
        <p className={styles.status}>
          {narrowed
            ? 'No row passes all of that. Remove a filter above to widen it.'
            : 'This table is empty — it has columns, but nothing stored yet.'}
        </p>
      ) : null}

      {/* THE TABLE */}
      {data && data.rows.length > 0 ? (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                {shownIndexes.map((i) => {
                  const column = data.columns[i];
                  const sortedHere = sort?.column === column ? sort : null;
                  const filtered = filters.some((f) => f.column === column);
                  return (
                    <th
                      key={column}
                      className={primaryKeys.has(column) ? styles.keyColumn : undefined}
                      aria-sort={sortedHere ? (sortedHere.descending ? 'descending' : 'ascending') : 'none'}
                    >
                      <div className={styles.headCell}>
                        <button
                          type="button"
                          className={openColumn === column ? styles.headNameOn : styles.headName}
                          onClick={() => setOpenColumn(openColumn === column ? null : column)}
                          title={`About the ${column} column — what it holds, its values, and filters`}
                        >
                          {column}
                          {filtered ? <span className={styles.filteredDot} aria-label="filtered" /> : null}
                        </button>
                        {frosted ? null : (
                        <button
                          type="button"
                          className={sortedHere ? styles.sortOn : styles.sortOff}
                          onClick={() => setSort(nextSort(sort, column))}
                          aria-label={`Sort by ${column}${sortedHere ? (sortedHere.descending ? ' — now descending; tap to stop sorting' : ' — now ascending; tap to reverse') : ''}`}
                        >
                          {sortedHere ? (sortedHere.descending ? '↓' : '↑') : '↕'}
                        </button>
                        )}
                      </div>
                    </th>
                  );
                })}
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
                      {shownIndexes.map((i) => (
                        <td
                          key={i}
                          className={[typeof row.cells[i] === 'number' ? styles.number : '',
                                      frosted ? styles.frostedCell : ''].filter(Boolean).join(' ') || undefined}
                        >
                          <div className={styles.cell}>
                            <Marked value={row.cells[i]} word={search} />
                          </div>
                        </td>
                      ))}
                    </tr>
                    {open ? (
                      <WholeRow
                        table={table}
                        allTables={allTables}
                        rowid={row.rowid}
                        word={search}
                        span={shownIndexes.length}
                        onJump={onJump}
                      />
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

      {/* THE SQL her taps have built. */}
      {data?.sql ? (
        <div className={styles.sqlBlock}>
          <button type="button" className={styles.linkButton} aria-expanded={showSql} onClick={() => setShowSql(!showSql)}>
            {showSql ? 'Hide the SQL' : 'Show the SQL this view is running'}
          </button>
          {showSql ? (
            <>
              <pre className={styles.sql}>{data.sql}</pre>
              <p className={styles.note}>
                Every search, filter and sort above is one piece of this sentence: WHERE keeps rows, ORDER
                BY sorts them, LIMIT takes one page. “IS NULL” sorts the empty ones last.
              </p>
              <button
                type="button"
                className={styles.pageBtn}
                onClick={() => {
                  handQueryToSqlRoom(data.sql!);
                  void navigate({ to: '/terrain/sql' });
                }}
              >
                Open this query in the SQL room →
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <p className={styles.note}>
        {sort ? '' : 'In the order the database stores them. '}Tap a column’s name to learn about it and
        filter by it; tap a row to read it whole. Looking only: nothing can be changed from this view.
      </p>
    </div>
  );
}
