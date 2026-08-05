/**
 * SandboxPanel — the writable half of the SQL page.
 *
 * Three things stacked: **lessons** (a concept each, loaded as visible SQL you
 * can read before running), a **builder** whose dropdowns are the syllabus —
 * seeing INNER / LEFT / CROSS listed together tells you what exists, which no
 * amount of typing practice does — and the **editor + output**.
 *
 * Output is per statement, not per script. A transaction is three outcomes: the
 * INSERT worked, the next one failed, the ROLLBACK undid both. Collapsing that
 * into one error message would destroy the only lesson worth having.
 *
 * Errors render as results rather than as failures, because here they usually
 * ARE the point — "UNIQUE constraint failed: people.email" is what lesson 2
 * exists to produce. The raw SQLite text is shown verbatim.
 *
 * Everything runs against sandbox.db (routes/sandbox.py), a separate file. No
 * statement typed here can reach real data, which is why nothing is filtered.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { bulkFill, execSandbox, getSandboxSchema, resetSandbox } from './api';
import {
  DEFAULT_SPEC,
  EMPTY_COLUMN,
  STATEMENT_LABELS,
  buildStatement,
  relevantOptions,
  type BuilderSpec,
  type ConflictKind,
  type JoinKind,
  type StatementKind,
  type WrapKind,
} from './builder';
import { LESSONS } from './lessons';
import type { SandboxResponse, SqlCell, SqlTable } from './types';
import styles from './SandboxPanel.module.css';

const STORAGE_KEY = 'sandbox_sql';
const KINDS = Object.keys(STATEMENT_LABELS) as StatementKind[];
const JOINS: JoinKind[] = ['none', 'INNER JOIN', 'LEFT JOIN', 'CROSS JOIN'];
const CONFLICTS: ConflictKind[] = ['none', 'OR IGNORE', 'OR REPLACE', 'ON CONFLICT DO UPDATE'];
const WRAPS: { value: WrapKind; label: string }[] = [
  { value: 'none', label: 'no transaction' },
  { value: 'commit', label: 'BEGIN … COMMIT (keep it)' },
  { value: 'rollback', label: 'BEGIN … ROLLBACK (undo it)' },
];
const TYPES = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'];

function renderCell(cell: SqlCell) {
  if (cell === null) return <span className={styles.null}>NULL</span>;
  return String(cell);
}

export function SandboxPanel() {
  const [tables, setTables] = useState<SqlTable[]>([]);
  const [sql, setSql] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? LESSONS[0].sql;
    } catch {
      return LESSONS[0].sql;
    }
  });
  const [spec, setSpec] = useState<BuilderSpec>(DEFAULT_SPEC);
  const [response, setResponse] = useState<SandboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  const loadSchema = useCallback(() => {
    getSandboxSchema()
      .then((d) => setTables(d.tables))
      .catch(() => setTables([]));
  }, []);

  useEffect(loadSchema, [loadSchema]);

  const set = <K extends keyof BuilderSpec>(key: K, value: BuilderSpec[K]) =>
    setSpec((s) => ({ ...s, [key]: value }));

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await execSandbox(sql);
      setResponse(r);
      setTables(r.tables);
      try {
        localStorage.setItem(STORAGE_KEY, sql);
      } catch {
        // private mode — it still ran
      }
    } catch (e: unknown) {
      setResponse(null);
      setError(e instanceof ApiError ? e.message : 'Could not run that');
    } finally {
      setBusy(false);
    }
  }, [sql]);

  const doReset = useCallback(async () => {
    if (!window.confirm('Drop every table in the sandbox? Your real data is untouched.')) return;
    setBusy(true);
    try {
      const r = await resetSandbox();
      setTables(r.tables);
      setResponse(null);
      setNote(`Dropped ${r.dropped} table${r.dropped === 1 ? '' : 's'}. Clean slate.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const doBulk = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await bulkFill(200_000);
      setTables(r.tables);
      setNote(`Built a "big" table with ${r.rows.toLocaleString()} rows in ${r.ms} ms. Lesson 9 works now.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Fill failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const opts = relevantOptions(spec.kind);
  const shows = (name: string) => opts.includes(name);

  return (
    <div className={styles.sandbox}>
      <div className={styles.warnBar}>
        This is a scratch database — <strong>sandbox.db</strong>, a separate file. Anything goes:
        DROP, DELETE, whatever. Your real data isn't reachable from here.
      </div>

      <div className={styles.lessons}>
        {LESSONS.map((l) => (
          <button
            key={l.key}
            type="button"
            className={styles.lesson}
            title={l.teaches}
            onClick={() => {
              setSql(l.sql);
              setNote(`${l.teaches} — Watch: ${l.watch}`);
              setResponse(null);
            }}
          >
            {l.title}
          </button>
        ))}
      </div>

      <div className={styles.layout}>
        <aside className={styles.schema}>
          <div className={styles.schemaHead}>Sandbox tables</div>
          {tables.length === 0 && <div className={styles.emptySchema}>No tables yet — start with lesson 1.</div>}
          {tables.map((t) => (
            <div key={t.name}>
              <div className={styles.tableRow}>
                <span className={styles.tableName}>{t.name}</span>
                <span className={styles.rowCount}>{t.rows.toLocaleString()}</span>
              </div>
              {t.columns.map((c) => (
                <div key={c.name} className={styles.column}>
                  <span className={styles.colName}>{c.name}</span>
                  <span className={styles.colType}>
                    {c.type}
                    {c.pk ? ' · pk' : ''}
                    {c.notnull && !c.pk ? ' · not null' : ''}
                  </span>
                </div>
              ))}
              {t.indexes.map((i) => (
                <div key={i.name} className={styles.indexRow}>
                  {i.unique ? 'unique index' : 'index'} · {i.name}
                </div>
              ))}
            </div>
          ))}
          <div className={styles.schemaActions}>
            <button type="button" className={styles.smallBtn} onClick={() => void doBulk()} disabled={busy}>
              Fill with 200k rows
            </button>
            <button type="button" className={styles.dangerBtn} onClick={() => void doReset()} disabled={busy}>
              Reset sandbox
            </button>
          </div>
        </aside>

        <section className={styles.main}>
          <button
            type="button"
            className={styles.builderToggle}
            onClick={() => setShowBuilder((v) => !v)}
          >
            {showBuilder ? '▾' : '▸'} Build a statement
          </button>

          {showBuilder && (
            <div className={styles.builder}>
              <div className={styles.kinds}>
                {KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={spec.kind === k ? styles.kindOn : styles.kind}
                    onClick={() => set('kind', k)}
                  >
                    {STATEMENT_LABELS[k]}
                  </button>
                ))}
              </div>

              <div className={styles.fields}>
                <label className={styles.field}>
                  <span>table</span>
                  <input
                    list="sandbox-tables"
                    value={spec.table}
                    onChange={(e) => set('table', e.target.value)}
                    placeholder="people"
                  />
                </label>
                <datalist id="sandbox-tables">
                  {tables.map((t) => (
                    <option key={t.name} value={t.name} />
                  ))}
                </datalist>

                {shows('columns') && (
                  <label className={styles.field}>
                    <span>columns</span>
                    <input value={spec.columns} onChange={(e) => set('columns', e.target.value)} />
                  </label>
                )}
                {shows('distinct') && (
                  <label className={styles.check}>
                    <input type="checkbox" checked={spec.distinct} onChange={(e) => set('distinct', e.target.checked)} />
                    <span>DISTINCT</span>
                  </label>
                )}
                {shows('join') && (
                  <>
                    <label className={styles.field}>
                      <span>join</span>
                      <select value={spec.joinKind} onChange={(e) => set('joinKind', e.target.value as JoinKind)}>
                        {JOINS.map((j) => (
                          <option key={j} value={j}>{j}</option>
                        ))}
                      </select>
                    </label>
                    {spec.joinKind !== 'none' && (
                      <>
                        <label className={styles.field}>
                          <span>join table</span>
                          <input list="sandbox-tables" value={spec.joinTable} onChange={(e) => set('joinTable', e.target.value)} />
                        </label>
                        {spec.joinKind !== 'CROSS JOIN' && (
                          <label className={styles.field}>
                            <span>on</span>
                            <input value={spec.joinOn} onChange={(e) => set('joinOn', e.target.value)} placeholder="a.id = b.a_id" />
                          </label>
                        )}
                      </>
                    )}
                  </>
                )}
                {shows('where') && (
                  <label className={styles.field}>
                    <span>where</span>
                    <input value={spec.where} onChange={(e) => set('where', e.target.value)} placeholder="age > 30" />
                  </label>
                )}
                {shows('groupBy') && (
                  <label className={styles.field}>
                    <span>group by</span>
                    <input value={spec.groupBy} onChange={(e) => set('groupBy', e.target.value)} />
                  </label>
                )}
                {shows('having') && (
                  <label className={styles.field}>
                    <span>having</span>
                    <input value={spec.having} onChange={(e) => set('having', e.target.value)} placeholder="COUNT(*) > 1" />
                  </label>
                )}
                {shows('orderBy') && (
                  <label className={styles.field}>
                    <span>order by</span>
                    <input value={spec.orderBy} onChange={(e) => set('orderBy', e.target.value)} />
                  </label>
                )}
                {shows('limit') && (
                  <label className={styles.field}>
                    <span>limit</span>
                    <input value={spec.limit} onChange={(e) => set('limit', e.target.value)} />
                  </label>
                )}
                {shows('values') && (
                  <label className={styles.field}>
                    <span>values</span>
                    <input value={spec.values} onChange={(e) => set('values', e.target.value)} placeholder="'Ada', 31" />
                  </label>
                )}
                {shows('conflict') && (
                  <>
                    <label className={styles.field}>
                      <span>on conflict</span>
                      <select value={spec.conflict} onChange={(e) => set('conflict', e.target.value as ConflictKind)}>
                        {CONFLICTS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                    {spec.conflict === 'ON CONFLICT DO UPDATE' && (
                      <>
                        <label className={styles.field}>
                          <span>conflict on</span>
                          <input value={spec.conflictTarget} onChange={(e) => set('conflictTarget', e.target.value)} placeholder="email" />
                        </label>
                        <label className={styles.field}>
                          <span>then set</span>
                          <input value={spec.conflictSet} onChange={(e) => set('conflictSet', e.target.value)} placeholder="age = excluded.age" />
                        </label>
                      </>
                    )}
                  </>
                )}
                {shows('set') && (
                  <label className={styles.field}>
                    <span>set</span>
                    <input value={spec.setClause} onChange={(e) => set('setClause', e.target.value)} placeholder="age = 40" />
                  </label>
                )}
                {shows('indexName') && (
                  <label className={styles.field}>
                    <span>index name</span>
                    <input value={spec.indexName} onChange={(e) => set('indexName', e.target.value)} placeholder="(auto)" />
                  </label>
                )}
                {shows('indexColumns') && (
                  <label className={styles.field}>
                    <span>index on</span>
                    <input value={spec.indexColumns} onChange={(e) => set('indexColumns', e.target.value)} placeholder="category" />
                  </label>
                )}
                {shows('indexUnique') && (
                  <label className={styles.check}>
                    <input type="checkbox" checked={spec.indexUnique} onChange={(e) => set('indexUnique', e.target.checked)} />
                    <span>UNIQUE</span>
                  </label>
                )}
                {shows('ifNotExists') && (
                  <label className={styles.check}>
                    <input type="checkbox" checked={spec.ifNotExists} onChange={(e) => set('ifNotExists', e.target.checked)} />
                    <span>{spec.kind === 'drop_table' ? 'IF EXISTS' : 'IF NOT EXISTS'}</span>
                  </label>
                )}
                <label className={styles.field}>
                  <span>wrap in</span>
                  <select value={spec.wrap} onChange={(e) => set('wrap', e.target.value as WrapKind)}>
                    {WRAPS.map((w) => (
                      <option key={w.value} value={w.value}>{w.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              {shows('newColumns') && (
                <div className={styles.columnsEditor}>
                  <div className={styles.columnsHead}>Columns — tick what the database should enforce</div>
                  {spec.newColumns.map((col, i) => (
                    <div key={i} className={styles.colRow}>
                      <input
                        className={styles.colInput}
                        value={col.name}
                        placeholder="name"
                        onChange={(e) => {
                          const next = [...spec.newColumns];
                          next[i] = { ...col, name: e.target.value };
                          set('newColumns', next);
                        }}
                      />
                      <select
                        value={col.type}
                        onChange={(e) => {
                          const next = [...spec.newColumns];
                          next[i] = { ...col, type: e.target.value };
                          set('newColumns', next);
                        }}
                      >
                        {TYPES.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      {(['pk', 'notNull', 'unique'] as const).map((flag) => (
                        <label key={flag} className={styles.flag}>
                          <input
                            type="checkbox"
                            checked={col[flag]}
                            onChange={(e) => {
                              const next = [...spec.newColumns];
                              next[i] = { ...col, [flag]: e.target.checked };
                              set('newColumns', next);
                            }}
                          />
                          <span>{flag === 'pk' ? 'PK' : flag === 'notNull' ? 'NOT NULL' : 'UNIQUE'}</span>
                        </label>
                      ))}
                      <input
                        className={styles.colInput}
                        value={col.check}
                        placeholder="CHECK (…)"
                        onChange={(e) => {
                          const next = [...spec.newColumns];
                          next[i] = { ...col, check: e.target.value };
                          set('newColumns', next);
                        }}
                      />
                      <input
                        className={styles.colInput}
                        value={col.references}
                        placeholder="REFERENCES t(id)"
                        onChange={(e) => {
                          const next = [...spec.newColumns];
                          next[i] = { ...col, references: e.target.value };
                          set('newColumns', next);
                        }}
                      />
                      <button
                        type="button"
                        className={styles.removeCol}
                        aria-label={`Remove column ${i + 1}`}
                        onClick={() => set('newColumns', spec.newColumns.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => set('newColumns', [...spec.newColumns, { ...EMPTY_COLUMN }])}
                  >
                    + column
                  </button>
                </div>
              )}

              <pre className={styles.preview}>{buildStatement(spec)}</pre>
              <button
                type="button"
                className={styles.smallBtn}
                onClick={() => setSql((cur) => (cur.trim() ? `${cur.trim()}\n\n${buildStatement(spec)}` : buildStatement(spec)))}
              >
                Add to editor ↓
              </button>
            </div>
          )}

          <textarea
            className={styles.editor}
            value={sql}
            spellCheck={false}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
            aria-label="Sandbox SQL"
          />

          <div className={styles.actions}>
            <button type="button" className={styles.runBtn} onClick={() => void run()} disabled={busy}>
              {busy ? 'Running…' : 'Run'}
            </button>
            <span className={styles.hint}>⌘/Ctrl + Enter · every statement runs in order</span>
          </div>

          {note && <div className={styles.note}>{note}</div>}
          {error && <div className={styles.error}>{error}</div>}

          {response?.rolled_back && (
            <div className={styles.warn}>
              The script left a transaction open, so it was rolled back. Add a COMMIT if you meant
              to keep the changes.
            </div>
          )}

          {response?.results.map((r, i) => (
            <div key={i} className={r.ok ? styles.result : styles.resultBad}>
              <pre className={styles.resultSql}>{r.sql}</pre>
              {r.error ? (
                <div className={styles.errorText}>{r.error}</div>
              ) : (
                <div className={styles.resultMeta}>
                  {r.changed !== null && <strong>{r.changed} row{r.changed === 1 ? '' : 's'} changed</strong>}
                  {r.changed !== null && r.columns.length > 0 && ' · '}
                  {r.columns.length > 0 && `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}`}
                  {r.changed === null && r.columns.length === 0 && 'done'}
                  {` · ${r.ms} ms`}
                </div>
              )}
              {r.truncated && (
                <div className={styles.warn}>Showing the first {r.rows.length} rows — there are more.</div>
              )}
              {r.columns.length > 0 && (
                <div className={styles.gridWrap}>
                  <table className={styles.grid}>
                    <thead>
                      <tr>
                        {r.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.rows.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci}>{renderCell(cell)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
