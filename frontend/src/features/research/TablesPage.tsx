/**
 * TablesPage.tsx — the research tables at /research/tables: her foods down the
 * side, a branch of the hazard map (or the lenses, for a verdict table) across
 * the top, and in each cell the numbers her research agents found — every one
 * traceable to its study and marked by her review.
 *
 * Layout: a row of pills to pick a table (plus "new table" and "hazard map"),
 * then the grid, with the cell she taps opened in a pane beside it
 * (TableDetail.tsx) — the claims page's two-column shape, stacking under
 * 720px. A cell's left edge says its review state: amber = something in it is
 * waiting for her, green = all confirmed, red = something disputed. "≈" marks
 * a number measured on a stand-in food.
 *
 * Data: useTables / useTableView / useHazards (useTablesData.ts, backed by
 * routes/research_tables.py → hazardstore.py). Search params (?table=&food=
 * &col=&view=&all=) are the page's whole selection state, typed by
 * routes/research_.tables.tsx. The cell arithmetic lives in tableMath.ts.
 *
 * Built on the owner's ask: "I want my research tool to be able to create sql
 * tables … a potential contaminant table … for every food I list … link to
 * the studies and put values in the table too … I want the agents to fill the
 * table but I want it to mark it as reviewed by me or not … and a judgment
 * table for buy organic or not."
 */

import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { ToastStack } from '../../ui';
import { useToasts } from '../journal/useJournalData';
import { researchErrorMessage } from './api';
import { HazardMap } from './HazardMap';
import { NewTableForm } from './NewTableForm';
import { TableDetail } from './TableDetail';
import { cellHeadline, cellReview, formatAmount, isMeasure } from './tableMath';
import { REVIEW_CLASS } from './tableStyles';
import type { CellEntry, JudgmentSummary, MeasureSummary, TableColumn, TableView, TablesVocab } from './types';
import { useTableView, useTables, useTablesMutations } from './useTablesData';
import pageStyles from './ResearchPage.module.css';
import claimStyles from './ClaimsPage.module.css';
import styles from './TablesPage.module.css';

/** The page's selection state, carried in the URL so a cell can be linked to. */
export interface TablesSearch {
  table?: number;
  food?: number;
  col?: string;
  view?: 'map' | 'new';
  all?: boolean;
}

const ROUTE_ID = '/research_/tables' as const;
const ROUTE_PATH = '/research/tables' as const;

/** Short words a verdict cell shows; the full words are in the vocabulary. */
const VERDICT_SHORT: Record<string, string> = {
  organic: 'buy organic',
  some: 'organic helps some',
  conventional: 'conventional ok',
  open: 'open',
};

export function TablesPage() {
  const search = useSearch({ from: ROUTE_ID }) as TablesSearch;
  const navigate = useNavigate({ from: ROUTE_PATH });
  const { toasts, push, dismiss } = useToasts();
  const mutations = useTablesMutations(push);

  const tablesQuery = useTables();
  const tables = tablesQuery.data?.tables ?? [];
  const vocab = tablesQuery.data?.vocab;
  const tableId = search.table ?? null;
  const viewQuery = useTableView(search.view ? null : tableId, !!search.all);

  // Rewrite the URL's selection — the only state the page keeps.
  function go(patch: Partial<TablesSearch>) {
    void navigate({
      search: (previous) => {
        const next: TablesSearch = { ...previous, ...patch };
        for (const key of Object.keys(next) as (keyof TablesSearch)[]) {
          if (next[key] === undefined || next[key] === false) delete next[key];
        }
        return next;
      },
    });
  }

  const view = viewQuery.data;
  const cellOpen = search.food !== undefined && !!search.col && !!view;
  const tablesError = tablesQuery.isError
    ? researchErrorMessage(tablesQuery.error, 'Could not load the tables.', 'Tables')
    : null;

  return (
    <div className={`${pageStyles.page} ${claimStyles.page}`}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>Tables</h1>
        <span className={pageStyles.pageSub}>every number with its study</span>
        <Link to="/research/claims" search={{}} className={pageStyles.pageHeadLink} title="The claims table">
          &#9776; Claims
        </Link>
      </div>

      {/* Pick a table — or make one, or open the hazard map. */}
      <div className={claimStyles.filters}>
        <div className={claimStyles.pillRow}>
          {tables.map((table) => (
            <button
              type="button"
              key={table.id}
              className={`${pageStyles.chip} ${!search.view && tableId === table.id ? pageStyles.chipActive : ''}`}
              onClick={() => go({ table: table.id, food: undefined, col: undefined, view: undefined })}
            >
              {table.kind === 'judgments' ? '⚖︎ ' : '▦ '}
              {table.name}
            </button>
          ))}
          <button
            type="button"
            className={`${pageStyles.chip} ${search.view === 'new' ? pageStyles.chipActive : ''}`}
            onClick={() => go({ view: search.view === 'new' ? undefined : 'new' })}
          >
            + new table
          </button>
          <button
            type="button"
            className={`${pageStyles.chip} ${search.view === 'map' ? pageStyles.chipActive : ''}`}
            onClick={() => go({ view: search.view === 'map' ? undefined : 'map' })}
          >
            &#128506;&#65039; hazard map
          </button>
        </div>
      </div>

      {tablesError ? (
        <div className={claimStyles.errorNote}>{tablesError}</div>
      ) : search.view === 'new' && vocab ? (
        <NewTableForm
          vocab={vocab}
          saving={mutations.addTable.isPending}
          onCreate={(body) =>
            mutations.addTable.mutate(body, {
              onSuccess: (made) => go({ table: made.table.id, view: undefined, food: undefined, col: undefined }),
            })
          }
          onCancel={() => go({ view: undefined })}
        />
      ) : search.view === 'map' ? (
        <HazardMap mutations={mutations} />
      ) : tableId === null ? (
        <div className={claimStyles.emptyNote}>
          {tablesQuery.isLoading
            ? 'Loading…'
            : tables.length
              ? 'Pick a table above.'
              : 'No tables yet — make one with “+ new table”, then point a research agent at it.'}
        </div>
      ) : viewQuery.isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : viewQuery.isError || !view ? (
        <div className={claimStyles.errorNote}>
          {viewQuery.isError ? researchErrorMessage(viewQuery.error, 'Could not load this table.') : 'No such table.'}
        </div>
      ) : (
        <div className={`${claimStyles.main} ${cellOpen ? claimStyles.detailOpen : ''}`}>
          <div className={styles.gridColumn}>
            <GridSummary
              view={view}
              allFoods={!!search.all}
              onToggleAll={() => go({ all: !search.all })}
              onDelete={() =>
                mutations.deleteTable.mutate(view.table.id, {
                  onSuccess: () => go({ table: undefined, food: undefined, col: undefined }),
                })
              }
            />
            <Grid
              view={view}
              vocab={vocab}
              selected={cellOpen ? { food: search.food!, col: search.col! } : null}
              onPick={(food, col) => go({ food, col })}
            />
          </div>
          {cellOpen ? (
            <div className={claimStyles.detail}>
              <button type="button" className={claimStyles.backBar} onClick={() => go({ food: undefined, col: undefined })}>
                &#8249; whole table
              </button>
              <TableDetail
                view={view}
                vocab={vocab}
                foodId={search.food!}
                columnId={search.col!}
                mutations={mutations}
                onClose={() => go({ food: undefined, col: undefined })}
              />
            </div>
          ) : null}
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/** The line above the grid: what's waiting for her, the empty-foods toggle,
 * and deleting the table (which only removes the view, never the numbers). */
function GridSummary({
  view,
  allFoods,
  onToggleAll,
  onDelete,
}: {
  view: TableView;
  allFoods: boolean;
  onToggleAll: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { counts } = view;
  return (
    <div className={styles.summary}>
      <span className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipInteresting}`}>
        {counts.unreviewed} to review
      </span>
      <span className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipVerified}`}>
        {counts.confirmed} confirmed
      </span>
      {counts.disputed ? (
        <span className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipShaky}`}>
          {counts.disputed} disputed
        </span>
      ) : null}
      <button type="button" className={pageStyles.chip} onClick={onToggleAll}>
        {allFoods ? 'hide foods with nothing yet' : `show all foods (+${view.empty_foods} with nothing yet)`}
      </button>
      {/* Destructive, so it asks once more before it goes. */}
      {confirming ? (
        <>
          <button type="button" className={`${pageStyles.chip} ${pageStyles.chipSure}`} onClick={onDelete}>
            delete this table?
          </button>
          <button type="button" className={pageStyles.chip} onClick={() => setConfirming(false)}>
            keep it
          </button>
        </>
      ) : (
        <button type="button" className={`${pageStyles.chip} ${pageStyles.chipDanger} ${styles.pushRight}`} onClick={() => setConfirming(true)}>
          delete table
        </button>
      )}
    </div>
  );
}

/** The grid itself: a real <table>, the food column pinned while it scrolls
 * sideways. Every cell is a button that opens it in the pane. */
function Grid({
  view,
  vocab,
  selected,
  onPick,
}: {
  view: TableView;
  vocab: TablesVocab | undefined;
  selected: { food: number; col: string } | null;
  onPick: (food: number, col: string) => void;
}) {
  if (!view.rows.length) {
    return (
      <div className={claimStyles.emptyNote}>
        Nothing in this table yet. Ask a research agent to fill it — from the research room, “fill table “{view.table.name}”” —
        and the numbers land here, waiting for your review.
      </div>
    );
  }
  return (
    <div className={styles.gridScroll}>
      <table className={styles.grid}>
        <thead>
          <tr>
            <th className={styles.foodHead}>Food</th>
            {view.columns.map((column) => (
              <th key={column.id} className={styles.colHead}>
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.food_id}>
              <th className={styles.foodCell} scope="row">
                {row.food}
              </th>
              {view.columns.map((column) => (
                <td key={column.id} className={styles.td}>
                  <Cell
                    entries={row.cells[column.id] ?? []}
                    column={column}
                    view={view}
                    vocab={vocab}
                    selected={!!selected && selected.food === row.food_id && selected.col === column.id}
                    onPick={() => onPick(row.food_id, column.id)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One cell: its headline number (or verdict), how many more sit behind it,
 * and its review state as the colour of its left edge. */
function Cell({
  entries,
  column,
  view,
  vocab,
  selected,
  onPick,
}: {
  entries: CellEntry[];
  column: TableColumn;
  view: TableView;
  vocab: TablesVocab | undefined;
  selected: boolean;
  onPick: () => void;
}) {
  const base = `${styles.cell} ${selected ? styles.cellSelected : ''}`;
  if (!entries.length) {
    return (
      <button type="button" className={`${base} ${styles.cellEmpty}`} onClick={onPick} aria-label={`${column.name}: nothing yet`}>
        &mdash;
      </button>
    );
  }
  const edge = REVIEW_CLASS[cellReview(entries)];
  const more = entries.length > 1 ? <span className={styles.more}>+{entries.length - 1}</span> : null;

  if (isMeasure(entries[0])) {
    const measures = entries as MeasureSummary[];
    const headline = cellHeadline(measures, view.table.measure)!;
    // A family column names which member the headline number is about.
    const member = headline.hazard !== column.name ? headline.hazard : null;
    return (
      <button type="button" className={`${base} ${edge}`} onClick={onPick}>
        <span className={styles.cellMain}>
          {headline.measured_on ? <span title={`measured on ${headline.measured_on}`}>≈</span> : null}
          {formatAmount(headline.amount, headline.unit)}
          {more}
        </span>
        {member ? <span className={styles.cellSub}>{member}</span> : null}
        {!headline.sourced ? <span className={styles.cellSub}>no source</span> : null}
      </button>
    );
  }

  const verdicts = entries as JudgmentSummary[];
  const whole = verdicts.find((verdict) => verdict.hazard === null) ?? verdicts[0];
  return (
    <button type="button" className={`${base} ${edge}`} onClick={onPick} title={vocab?.verdicts[whole.verdict]}>
      <span className={styles.cellMain}>
        {whole.shaken ? <span title="a number under this verdict is disputed">⚠︎</span> : null}
        {VERDICT_SHORT[whole.verdict] ?? whole.verdict}
        {more}
      </span>
      {whole.hazard ? <span className={styles.cellSub}>{whole.hazard} only</span> : null}
    </button>
  );
}
