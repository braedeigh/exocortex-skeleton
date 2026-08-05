/**
 * SqlLabPage — a read-only SQL console over exo.db, for learning by poking.
 *
 * Three panes: the schema down the left (every table, its columns, its
 * indexes, its row count), a query editor with a ladder of clickable example
 * queries, and the result below it.
 *
 * Two deliberate choices:
 *   - The query plan is shown with every result, not hidden behind a button.
 *     Seeing 'SCAN habit_entries' turn into 'SEARCH … USING INDEX' is how an
 *     index stops being a word and starts being a thing that happened.
 *   - Truncation is stated loudly. A result silently cut at 500 rows reads as
 *     "that's all there is", which is the one lie a learning tool must not tell.
 *
 * The server refuses anything but a single SELECT / WITH / EXPLAIN on a
 * read-only connection (routes/sqlab.py), so nothing typed here can change
 * data. The Rebuild button re-derives the habit tables from habits_log, which
 * is the real undo: those three tables are wholly derived.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { getCollections, getSchema, rebuildHabits, runQuery } from './api';
import { CollectionMap } from './CollectionMap';
import { EXAMPLES } from './examples';
import type { Collection, SqlCell, SqlResult, SqlTable, TypedTable } from './types';
import styles from './SqlLabPage.module.css';

const STORAGE_KEY = 'sqlab_query';
const VIEW_KEY = 'sqlab_view';

type View = 'map' | 'console';

function readStoredView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'console' ? 'console' : 'map';
  } catch {
    return 'map';
  }
}

function readStoredQuery(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? EXAMPLES[0].sql;
  } catch {
    return EXAMPLES[0].sql;
  }
}

/** NULL has to look different from the empty string, or results quietly lie. */
function renderCell(cell: SqlCell) {
  if (cell === null) return <span className={styles.null}>NULL</span>;
  if (typeof cell === 'boolean') return String(cell);
  return String(cell);
}

export function SqlLabPage() {
  const [view, setView] = useState<View>(readStoredView);
  const [tables, setTables] = useState<SqlTable[]>([]);
  const [blobs, setBlobs] = useState<Collection[]>([]);
  const [typed, setTyped] = useState<TypedTable[]>([]);
  const [openTable, setOpenTable] = useState<string | null>('habits');
  const [sql, setSql] = useState(readStoredQuery);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const loadSchema = useCallback(() => {
    getSchema()
      .then((d) => setTables(d.tables))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load schema'));
    getCollections()
      .then((d) => {
        setBlobs(d.blobs);
        setTyped(d.typed);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not load collections'),
      );
  }, []);

  useEffect(loadSchema, [loadSchema]);

  const pickView = useCallback((next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // private mode — the view still switched, just won't be remembered
    }
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await runQuery(sql);
      setResult(r);
      try {
        localStorage.setItem(STORAGE_KEY, sql);
      } catch {
        // private mode / quota — the query still ran, so don't surface this
      }
    } catch (e: unknown) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : 'Query failed');
    } finally {
      setBusy(false);
    }
  }, [sql]);

  const rebuild = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await rebuildHabits();
      setNote(`Rebuilt ${r.habits} habits from habits_log. The log itself was not touched.`);
      loadSchema();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Rebuild failed');
    } finally {
      setBusy(false);
    }
  }, [loadSchema]);

  // Cmd/Ctrl+Enter runs, because reaching for the mouse between edits is what
  // stops you from trying the small variation you were curious about.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>SQL</h2>
        <div className={styles.viewSwitch}>
          <button
            type="button"
            className={view === 'map' ? styles.viewBtnOn : styles.viewBtn}
            onClick={() => pickView('map')}
          >
            Map
          </button>
          <button
            type="button"
            className={view === 'console' ? styles.viewBtnOn : styles.viewBtn}
            onClick={() => pickView('console')}
          >
            Console
          </button>
        </div>
        <button type="button" className={styles.rebuildBtn} onClick={() => void rebuild()} disabled={busy}>
          ↻ Rebuild habit tables
        </button>
      </div>

      {note && <div className={styles.note}>{note}</div>}

      {view === 'map' && <CollectionMap blobs={blobs} typed={typed} />}

      {view === 'console' && (
      <div className={styles.layout}>
        <aside className={styles.schema}>
          <div className={styles.schemaHead}>Tables</div>
          {tables.map((t) => (
            <div key={t.name} className={styles.table}>
              <button
                type="button"
                className={styles.tableBtn}
                onClick={() => setOpenTable(openTable === t.name ? null : t.name)}
              >
                <span className={styles.chevron}>{openTable === t.name ? '▾' : '▸'}</span>
                <span className={styles.tableName}>{t.name}</span>
                <span className={styles.rowCount}>{t.rows.toLocaleString()}</span>
              </button>
              {openTable === t.name && (
                <div className={styles.columns}>
                  {t.columns.map((c) => (
                    <div key={c.name} className={styles.column}>
                      <span className={styles.colName}>{c.name}</span>
                      <span className={styles.colType}>
                        {c.type}
                        {c.pk ? ' · pk' : ''}
                      </span>
                    </div>
                  ))}
                  {t.indexes.length > 0 && (
                    <div className={styles.indexes}>
                      {t.indexes.map((i) => (
                        <div key={i.name} className={styles.index}>
                          {i.unique ? 'unique index' : 'index'} · {i.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </aside>

        <section className={styles.main}>
          <div className={styles.examples}>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.title}
                type="button"
                className={styles.example}
                title={ex.teaches}
                onClick={() => setSql(ex.sql)}
              >
                {ex.title}
              </button>
            ))}
          </div>

          <textarea
            className={styles.editor}
            value={sql}
            spellCheck={false}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="SQL query"
          />

          <div className={styles.actions}>
            <button type="button" className={styles.runBtn} onClick={() => void run()} disabled={busy}>
              {busy ? 'Running…' : 'Run'}
            </button>
            <span className={styles.hint}>⌘/Ctrl + Enter · read-only, writes are refused</span>
          </div>

          {error && <div className={styles.error}>{error}</div>}

          {result && (
            <div className={styles.result}>
              <div className={styles.meta}>
                {result.rows.length} row{result.rows.length === 1 ? '' : 's'} · {result.ms} ms
              </div>

              {result.truncated && (
                <div className={styles.truncated}>
                  Showing the first {result.limit} rows — there are more. Add a LIMIT or a WHERE to
                  see the rest.
                </div>
              )}

              {result.plan.length > 0 && (
                <div className={styles.plan}>
                  <div className={styles.planHead}>How SQLite ran it</div>
                  {result.plan.map((step, i) => (
                    <div key={i} className={styles.planStep}>
                      {step}
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.gridWrap}>
                <table className={styles.grid}>
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j}>{renderCell(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.rows.length === 0 && <div className={styles.empty}>No rows.</div>}
              </div>
            </div>
          )}
        </section>
      </div>
      )}
    </div>
  );
}
