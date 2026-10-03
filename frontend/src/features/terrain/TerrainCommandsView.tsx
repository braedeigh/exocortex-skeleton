import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  hourLabel,
  peakHour,
  rankCommands,
  staleLabel,
  type CommandsRecord,
  type RankedCommand,
} from './commandRanking';
import styles from './TerrainCommandsView.module.css';

/**
 * TerrainCommandsView — "which skills you reach for", one of the terrain's rooms.
 *
 * The attention room next door ranks the app's PAGES by the time they get. This
 * ranks the slash commands — the voices in ~/.claude/commands — by how often
 * they actually get called. Same organism, third axis, so it lives under
 * /terrain beside the others rather than on Settings.
 *
 * Reads GET /api/usage/commands, which commandstore.py fills by reading the
 * Claude Code transcripts (no hook runs at call time — see that module). One
 * fetch per window change, because unlike the attention room's single blob the
 * windowing here is done in SQL.
 *
 * Three decisions about the drawing:
 *
 * 1. **Ranked horizontal bars, one hue.** Same grammar as the attention room —
 *    magnitude across ~20 names that need room to be read, length carrying the
 *    number, colour carrying nothing it would only say twice.
 * 2. **"Last" is a column, not a footnote.** For pages the question is how long
 *    you stayed; for skills it's whether you still reach for it. A voice run
 *    nine times in June and never since looks identical to a healthy one in a
 *    column of counts alone, and those are opposite facts.
 * 3. **Never-run commands are rows, not an appendix.** They rank last with an
 *    empty track and "never" in the last column. Putting them in a separate
 *    line under the table is how you build something and never see that you
 *    stopped using it.
 *
 * Prompt that produced it: "build a / command tracker — I want to know when I'm
 * using different skills."
 */

const WINDOWS: readonly { days: number | null; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: null, label: 'All' },
];

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The 24 local hours as a strip of bars — the "when" of the question, drawn
 *  small. Its own scale: this is shape, not a second magnitude to compare
 *  against the table's. */
function HourStrip({ hours }: { hours: { hour: number; runs: number }[] }) {
  const max = hours.reduce((m, h) => Math.max(m, h.runs), 0);
  if (max === 0) return null;
  return (
    <div className={styles.clock} aria-hidden="true">
      {hours.map((h) => (
        <span key={h.hour} className={styles.tick} title={`${hourLabel(h.hour)} · ${h.runs}`}>
          <span className={styles.tickFill} style={{ height: `${(h.runs / max) * 100}%` }} />
        </span>
      ))}
    </div>
  );
}

export function TerrainCommandsView() {
  const [record, setRecord] = useState<CommandsRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [days, setDays] = useState<number | null>(null);

  // Re-fetched per window: the counting happens in SQL, so a window is a
  // different query rather than a slice of one payload. The old record stays
  // on screen while the new one loads — the table doesn't blank out under her.
  useEffect(() => {
    let alive = true;
    const qs = days ? `?days=${days}` : '';
    fetch(`/api/usage/commands${qs}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: CommandsRecord) => {
        if (!alive) return;
        setRecord(data);
        setState('ready');
      })
      .catch(() => {
        if (alive) setState('error');
      });
    return () => {
      alive = false;
    };
  }, [days]);

  const rows: RankedCommand[] = useMemo(() => rankCommands(record, today()), [record]);
  const max = rows[0]?.runs ?? 0;
  const totalRuns = rows.reduce((sum, r) => sum + r.runs, 0);
  const used = rows.filter((r) => r.runs > 0).length;
  const peak = peakHour(record);

  return (
    <section className={styles.view} aria-label="Which skills you reach for">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Which skills you reach for</h2>
          <p className={styles.sub}>
            Every <code>/</code> command you&rsquo;ve run — and the ones you haven&rsquo;t.
          </p>
        </div>
        <Link to="/terrain/files" className={styles.back} aria-label="Back to the terrain map">
          ← Terrain
        </Link>
      </header>

      <div className={styles.windows} role="group" aria-label="Time window">
        {WINDOWS.map((w) => (
          <button
            key={w.label}
            type="button"
            className={[styles.window, days === w.days ? styles.windowOn : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={days === w.days}
            onClick={() => setDays(w.days)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {state === 'loading' ? <p className={styles.note}>Reading the ledger…</p> : null}
      {state === 'error' ? (
        <p className={styles.note}>Couldn&rsquo;t read the command ledger.</p>
      ) : null}
      {state === 'ready' && rows.length === 0 ? (
        <p className={styles.note}>No commands recorded in this window yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <>
          {peak !== null ? (
            <div className={styles.when}>
              <HourStrip hours={record?.by_hour ?? []} />
              <p className={styles.whenLine}>
                Busiest around <strong>{hourLabel(peak)}</strong>
              </p>
            </div>
          ) : null}

          <div className={styles.columns} aria-hidden="true">
            <span />
            <span />
            <span className={styles.num}>runs</span>
            <span className={styles.num}>days</span>
            <span className={styles.num}>last</span>
          </div>

          <ol className={styles.list}>
            {rows.map((r) => {
              const pct = max > 0 ? (r.runs / max) * 100 : 0;
              return (
                <li
                  key={r.name}
                  className={[styles.row, r.runs === 0 ? styles.cold : ''].filter(Boolean).join(' ')}
                >
                  <span className={styles.label}>/{r.name}</span>
                  <span className={styles.track}>
                    {r.runs > 0 ? (
                      <span
                        className={styles.fill}
                        style={{ width: `${pct.toFixed(1)}%` }}
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                  <span className={[styles.num, styles.runs].join(' ')}>{r.runs || '—'}</span>
                  <span className={[styles.num, styles.muted].join(' ')}>{r.days || '—'}</span>
                  <span className={[styles.num, styles.muted].join(' ')}>
                    {staleLabel(r.staleDays)}
                  </span>
                </li>
              );
            })}
          </ol>

          <p className={styles.foot}>
            {used} of {rows.length} commands used · {totalRuns} runs
          </p>
        </>
      ) : null}
    </section>
  );
}
