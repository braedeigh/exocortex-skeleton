import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  formatDwell,
  rankPlaces,
  type PlaceUsage,
  type UsageRecord,
} from './usageRanking';
import styles from './TerrainUsageView.module.css';

/**
 * TerrainUsageView — "where you actually go", one of the terrain's rooms.
 *
 * Terrain draws the system as a body in SPACE: which files are hot, which agents
 * are working where. This is the same body ranked by ATTENTION — which rooms you
 * spend yourself in. Same organism, different axis, so it lives under /terrain
 * rather than on Settings.
 *
 * It's a whole page now (/terrain/usage, routes/terrain_.usage.tsx — un-nested,
 * so the map unmounts and this room owns the screen). It used to render inset
 * over the live map as a glass panel; that read as a modal, which is exactly
 * what the owner asked these rooms to stop being. You reach it through the
 * rooms index on the map (TerrainRoomsIndex), and "← Terrain" walks back.
 *
 * Reads GET /api/usage and nothing else. No new endpoint, no new collection —
 * the counters have run since July; there was simply never a surface comparing
 * one place to another (ui/usageHeat.ts only tints controls *within* /journal
 * and /todos). The ranking maths, the rename folding and the window slicing all
 * live in usageRanking.ts and are tested there.
 *
 * Four decisions about the drawing, all from one rule — the chart's job is
 * magnitude across named places:
 *
 * 1. **Horizontal bars, ranked.** Magnitude across ~16 categories whose names
 *    need room to be read; a vertical chart would turn every label sideways.
 * 2. **One hue, not sixteen.** Length already carries the magnitude, so colour
 *    would encode the same number twice — a per-place palette here is decoration
 *    wearing the costume of information. Identity comes from the labels.
 * 3. **Dwell drives the bar; opens and taps sit beside it in muted ink.** Three
 *    different questions — opened it / stayed / did something — and the
 *    revealing places are the ones that rank differently on each. Blending them
 *    into one score would hide exactly what this is for. Never a second axis;
 *    the second measure gets a column.
 * 4. **Numbers wear text tokens, never the bar's colour.** The coloured mark
 *    beside them carries identity; the ink stays ink.
 *
 * The extra width over a panel is spent on legibility — one row per place on a
 * single line, rows that breathe — not on more encodings.
 *
 * Prompts that produced it: "build a simple visualizer that lives in terrain,
 * with what I already have" / "they aren't modals. They need to be separate
 * pages."
 */

const WINDOWS: readonly { days: number | null; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: null, label: 'All' },
];

export function TerrainUsageView() {
  const [record, setRecord] = useState<UsageRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [days, setDays] = useState<number | null>(7);

  // One fetch per visit. The record is small and this is a reading, not a live
  // monitor — all three windows are slices of the same payload, so changing the
  // window re-slices rather than re-fetches.
  useEffect(() => {
    let alive = true;
    fetch('/api/usage', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: UsageRecord) => {
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
  }, []);

  const places: PlaceUsage[] = useMemo(() => rankPlaces(record, days), [record, days]);
  const max = places[0]?.seconds ?? 0;
  const totalSeconds = places.reduce((sum, p) => sum + p.seconds, 0);

  return (
    <section className={styles.view} aria-label="Where you actually go">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Where you actually go</h2>
          <p className={styles.sub}>The same system, ranked by attention instead of heat.</p>
        </div>
        {/* Back to the map, not a close ×: a page returns you somewhere named,
            and the terrain's map is where this room's door is. */}
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

      {state === 'loading' ? <p className={styles.note}>Reading the record…</p> : null}
      {state === 'error' ? (
        <p className={styles.note}>Couldn&rsquo;t read the usage record.</p>
      ) : null}
      {state === 'ready' && places.length === 0 ? (
        <p className={styles.note}>Nothing recorded in this window yet.</p>
      ) : null}

      {places.length > 0 ? (
        <>
          {/* Column headers rather than a colour legend: one series means the
              bar needs no key, but the three numbers do need naming. */}
          <div className={styles.columns} aria-hidden="true">
            <span />
            <span />
            <span className={styles.num}>time</span>
            <span className={styles.num}>opens</span>
            <span className={styles.num}>taps</span>
          </div>

          <ol className={styles.list}>
            {places.map((p) => {
              const pct = max > 0 ? Math.max(0, (p.seconds / max) * 100) : 0;
              return (
                <li key={p.key} className={styles.row}>
                  <span className={styles.label}>{p.label}</span>
                  <span className={styles.track}>
                    <span
                      className={styles.fill}
                      style={{ width: `${pct.toFixed(1)}%` }}
                      aria-hidden="true"
                    />
                  </span>
                  <span className={[styles.num, styles.dwell].join(' ')}>
                    {formatDwell(p.seconds)}
                  </span>
                  <span className={[styles.num, styles.muted].join(' ')}>{p.visits}</span>
                  <span className={[styles.num, styles.muted].join(' ')}>{p.taps}</span>
                </li>
              );
            })}
          </ol>

          <p className={styles.foot}>
            {places.length} places · {formatDwell(totalSeconds)} total
          </p>
        </>
      ) : null}
    </section>
  );
}
