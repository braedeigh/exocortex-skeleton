import { useEffect, useState } from 'react';
import { IconButton } from '../../ui';
import {
  daysAgo,
  toggleValue,
  useTableColumn,
  valueIsChosen,
  withFilter,
  withoutFilter,
  type TableCell,
  type TableColumnProfile,
  type TableFilter,
  type TableSort,
} from './tableRows';
import styles from './TerrainColumnCard.module.css';

/**
 * TerrainColumnCard — one COLUMN, explained and put to work. It opens when she
 * taps a column's name in the rows view.
 *
 * A column is one field, running down every row: `bucket` is the list each
 * to-do sits in, for all 282 of them. This card answers "what is this field,
 * and what's in it" — and because the answer IS the list of values, it is also
 * where a filter on that column gets made:
 *
 *   WHAT IT HOLDS  the hand-written description (table_notes.json), and its
 *                  role: the key that identifies a row, a pointer into another
 *                  table, required or optional.
 *   HOW FULL       rows with a value, rows without, how many different values,
 *                  and the smallest and largest (earliest and latest, for
 *                  dates).
 *   ITS VALUES     every value with how many rows carry it, a bar for scale,
 *                  and — for a column with a fixed set of categories — what
 *                  each value MEANS. Tapping a value keeps only the rows that
 *                  have it; tapping more adds them ("done or now"). A column
 *                  with too many values shows only the commonest; a column of
 *                  prose shows none, and says why.
 *   NARROW IT      the controls that suit the kind of column the data turns
 *                  out to be: yes/no, a number range, a date range with quick
 *                  spans, "contains" for text — plus empty / filled in, which
 *                  is how a database says "not finished yet".
 *   ORDER / HIDE   sort the table by this column, either way, or take the
 *                  column out of view.
 *
 * The numbers are for the WHOLE table, not the filtered rows — said on the
 * card, because a count that silently changed meaning with the filters would
 * be a trap.
 *
 * It owns no state of its own beyond what's typed in its boxes: the filters
 * and the sort live in TerrainTableRows, which hands them in and takes the
 * changes back. Profile fetching is tableRows.ts.
 *
 * Prompt that produced it: "see all the value categories for a given [column]
 * and a description of what [it] contains for each one" / "a more robust
 * feature to filter and sort the sql tables".
 */

/** What the two ends of a sort are called, for the kind of column it is. */
function sortWords(kind: TableColumnProfile['looks_like']): { up: string; down: string } {
  if (kind === 'date') return { up: 'Oldest first', down: 'Newest first' };
  if (kind === 'number' || kind === 'yesno') return { up: 'Smallest first', down: 'Largest first' };
  return { up: 'A → Z', down: 'Z → A' };
}

function shown(value: TableCell): string {
  return value === null ? 'empty' : String(value);
}

export function TerrainColumnCard({
  table,
  column,
  filters,
  sort,
  onFilters,
  onSort,
  onHide,
  onClose,
}: {
  table: string;
  column: string;
  filters: readonly TableFilter[];
  sort: TableSort | null;
  onFilters: (next: TableFilter[]) => void;
  onSort: (next: TableSort | null) => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const profile = useTableColumn(table, column);
  const data = profile.data;
  const mine = filters.filter((f) => f.column === column);
  const has = (op: TableFilter['op']) => mine.some((f) => f.op === op);
  const valueOf = (op: TableFilter['op']) => String(mine.find((f) => f.op === op)?.value ?? '');

  // What's typed in the boxes. Sent on Enter or on leaving the box, not on
  // every keystroke — half a date ("2026-0") is not a filter worth running.
  const [contains, setContains] = useState(valueOf('contains'));
  const [from, setFrom] = useState(valueOf('min'));
  const [upTo, setUpTo] = useState(valueOf('max'));

  // Keep the boxes in step with the filters when they change from OUTSIDE the
  // card — a chip's × above the table removes a filter, and a box still
  // showing the old text would be claiming a filter that's gone.
  const filterContains = valueOf('contains');
  const filterFrom = valueOf('min');
  const filterUpTo = valueOf('max');
  useEffect(() => setContains(filterContains), [filterContains]);
  useEffect(() => setFrom(filterFrom), [filterFrom]);
  useEffect(() => setUpTo(filterUpTo), [filterUpTo]);

  /** Set or clear one typed filter (contains / from / up to). */
  const commit = (op: 'contains' | 'min' | 'max', text: string) => {
    const trimmed = text.trim();
    onFilters(
      trimmed === ''
        ? withoutFilter(filters, column, op)
        : withFilter(filters, { column, op, value: trimmed }),
    );
  };

  /** Turn "only empty" / "only filled in" on or off. The two exclude each
   * other, and either one replaces any chosen values (a row can't both be
   * empty and be "done"). */
  const toggleEmptiness = (op: 'empty' | 'not_empty') => {
    const cleared = filters.filter(
      (f) => !(f.column === column && (f.op === 'empty' || f.op === 'not_empty' || f.op === 'is')),
    );
    onFilters(has(op) ? cleared : [...cleared, { column, op }]);
  };

  const words = sortWords(data?.looks_like ?? 'text');
  const sortedHere = sort?.column === column ? sort : null;
  const most = data?.values ? Math.max(1, ...data.values.map((v) => v.rows)) : 1;
  const meanings = data?.notes?.values ?? {};

  return (
    <section className={styles.card} aria-label={`The ${column} column`}>
      <div className={styles.head}>
        <h3 className={styles.name}>{column}</h3>
        {data ? <span className={styles.type}>{data.type || 'any type'}</span> : null}
        <IconButton aria-label="Close this column" onClick={onClose}>
          &times;
        </IconButton>
      </div>

      {profile.isError ? <p className={styles.muted}>Could not read this column.</p> : null}
      {!data && !profile.isError ? <p className={styles.muted}>Reading the column…</p> : null}

      {data ? (
        <>
          {/* WHAT IT HOLDS */}
          <p className={styles.holds}>
            {data.notes?.holds ?? 'Nobody has written a description of this column yet.'}
          </p>
          <p className={styles.muted}>
            {[
              data.primary_key ? 'Part of the key that identifies a row' : null,
              data.points_at
                ? `Points at ${data.points_at.table}${data.points_at.column ? `.${data.points_at.column}` : ''}`
                : null,
              data.required ? 'Required — every row must have one' : 'Optional — a row may leave it empty',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>

          {/* HOW FULL — for the whole table, and said so. */}
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statNumber}>{data.filled.toLocaleString()}</span>
              <span className={styles.statLabel}>rows have a value</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statNumber}>{data.empty.toLocaleString()}</span>
              <span className={styles.statLabel}>are empty</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statNumber}>{data.distinct.toLocaleString()}</span>
              <span className={styles.statLabel}>different {data.distinct === 1 ? 'value' : 'values'}</span>
            </div>
          </div>
          {/* Smallest and largest only mean something for numbers and dates —
              "the smallest bucket is done" is just alphabetical order. */}
          {data.filled > 0 && (data.looks_like === 'date' || data.looks_like === 'number') ? (
            <p className={styles.muted}>
              {data.looks_like === 'date' ? 'Earliest' : 'Smallest'} {shown(data.smallest)} ·{' '}
              {data.looks_like === 'date' ? 'latest' : 'largest'} {shown(data.largest)}
              {data.average !== null && data.looks_like === 'number'
                ? ` · average ${Number(data.average.toFixed(1)).toLocaleString()}`
                : ''}
            </p>
          ) : null}

          {/* ITS VALUES — tap to keep only the rows that have it. */}
          {data.values ? (
            <div className={styles.block}>
              <h4 className={styles.blockTitle}>
                {data.values_complete ? 'Every value' : `The ${data.values.length} most common values`}
                <span className={styles.blockHint}> — tap one to keep only those rows</span>
              </h4>
              <ul className={styles.values}>
                {data.values.map((entry) => {
                  const chosen = valueIsChosen(filters, column, entry.value);
                  const meaning = meanings[String(entry.value)];
                  return (
                    <li key={String(entry.value)}>
                      <button
                        type="button"
                        className={chosen ? styles.valueOn : styles.value}
                        aria-pressed={chosen}
                        onClick={() => onFilters(toggleValue(filters, column, entry.value))}
                      >
                        <span className={styles.bar} style={{ width: `${(entry.rows / most) * 100}%` }} aria-hidden="true" />
                        <span className={styles.valueText}>
                          <span className={styles.valueName}>{shown(entry.value)}</span>
                          {meaning ? <span className={styles.valueMeaning}>{meaning}</span> : null}
                        </span>
                        <span className={styles.valueRows}>{entry.rows.toLocaleString()}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className={styles.muted}>
              {data.prose
                ? 'No list of values: this column holds long text, where nearly every row is different. Use “contains” below to look inside it.'
                : 'This column has no values yet.'}
            </p>
          )}

          {/* NARROW IT — the controls that suit this kind of column. */}
          <div className={styles.block}>
            <h4 className={styles.blockTitle}>Narrow the rows</h4>
            <div className={styles.controls}>
              <button type="button" className={has('empty') ? styles.pillOn : styles.pill} aria-pressed={has('empty')} onClick={() => toggleEmptiness('empty')}>
                Only empty
              </button>
              <button type="button" className={has('not_empty') ? styles.pillOn : styles.pill} aria-pressed={has('not_empty')} onClick={() => toggleEmptiness('not_empty')}>
                Only filled in
              </button>
            </div>

            {data.looks_like === 'date' ? (
              <div className={styles.controls}>
                {[
                  { label: 'Today', days: 0 },
                  { label: 'Last 7 days', days: 7 },
                  { label: 'Last 30 days', days: 30 },
                  { label: 'Last year', days: 365 },
                ].map((span) => {
                  const start = daysAgo(span.days);
                  const on = valueOf('min') === start && !has('max');
                  return (
                    <button
                      key={span.label}
                      type="button"
                      className={on ? styles.pillOn : styles.pill}
                      aria-pressed={on}
                      onClick={() => {
                        setFrom(on ? '' : start);
                        setUpTo('');
                        const cleared = withoutFilter(withoutFilter(filters, column, 'min'), column, 'max');
                        onFilters(on ? cleared : [...cleared, { column, op: 'min', value: start }]);
                      }}
                    >
                      {span.label}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {data.looks_like === 'date' || data.looks_like === 'number' ? (
              <div className={styles.controls}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>From</span>
                  <input
                    className={styles.input}
                    type={data.looks_like === 'date' ? 'date' : 'number'}
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    onBlur={() => commit('min', from)}
                    onKeyDown={(e) => e.key === 'Enter' && commit('min', from)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Up to</span>
                  <input
                    className={styles.input}
                    type={data.looks_like === 'date' ? 'date' : 'number'}
                    value={upTo}
                    onChange={(e) => setUpTo(e.target.value)}
                    onBlur={() => commit('max', upTo)}
                    onKeyDown={(e) => e.key === 'Enter' && commit('max', upTo)}
                  />
                </label>
              </div>
            ) : null}

            {data.looks_like === 'text' || data.looks_like === 'category' ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Contains</span>
                <input
                  className={styles.input}
                  type="text"
                  value={contains}
                  placeholder={`text inside ${column}…`}
                  onChange={(e) => setContains(e.target.value)}
                  onBlur={() => commit('contains', contains)}
                  onKeyDown={(e) => e.key === 'Enter' && commit('contains', contains)}
                />
              </label>
            ) : null}
          </div>

          {/* ORDER / HIDE */}
          <div className={styles.block}>
            <h4 className={styles.blockTitle}>Order and view</h4>
            <div className={styles.controls}>
              <button
                type="button"
                className={sortedHere && !sortedHere.descending ? styles.pillOn : styles.pill}
                aria-pressed={Boolean(sortedHere && !sortedHere.descending)}
                onClick={() => onSort(sortedHere && !sortedHere.descending ? null : { column, descending: false })}
              >
                {words.up}
              </button>
              <button
                type="button"
                className={sortedHere?.descending ? styles.pillOn : styles.pill}
                aria-pressed={Boolean(sortedHere?.descending)}
                onClick={() => onSort(sortedHere?.descending ? null : { column, descending: true })}
              >
                {words.down}
              </button>
              <button type="button" className={styles.pill} onClick={onHide}>
                Hide this column
              </button>
            </div>
          </div>

          <p className={styles.muted}>
            These counts are for the whole table ({data.total.toLocaleString()} rows), not just the rows
            your filters have kept.
          </p>
        </>
      ) : null}
    </section>
  );
}
