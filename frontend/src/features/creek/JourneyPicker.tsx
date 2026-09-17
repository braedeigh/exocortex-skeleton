/**
 * JourneyPicker.tsx — record a journey, or pick one already captured.
 *
 * Plain English: the creek's Journey mode needs a journey. This is the card
 * in the creek's side column that records one ("Record what I do next" —
 * the browser starts carrying the id on everything it does, api/journey.ts)
 * and lists the captures the server kept, newest first. Picking one is what
 * lights the creek. Nothing here draws; it hands the chosen id back up.
 */
import { useEffect, useState } from 'react';
import { currentJourney, isLive, setLive, subscribeJourney } from '../../api/journey';
import { useArmJourney, useDisarmTrace, useTraces } from '../wiring/api';
import { formatDuration } from '../wiring/wiringMath';
import styles from './JourneyPicker.module.css';

export function JourneyPicker({
  picked,
  onPick,
}: {
  picked: string | null;
  onPick: (id: string) => void;
}) {
  const traces = useTraces();
  const arm = useArmJourney();
  const disarm = useDisarmTrace();
  const [, bump] = useState(0);
  useEffect(() => subscribeJourney(() => bump((n) => n + 1)), []);
  const live = isLive();
  const mine = currentJourney();
  const recording = mine || traces.data?.journey;
  const list = traces.data?.traces ?? [];
  const groups = groupByHour(list);

  return (
    <div className={styles.picker} data-journey-ui="">
      <label className={styles.live}>
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
        <span className={styles.liveText}>
          <strong>Live</strong> — record while I&rsquo;m looking
        </span>
      </label>
      {live ? (
        <div className={styles.rec}>
          <span className={styles.recDot} aria-hidden="true" />
          {mine ? 'recording this tab' : 'opening…'}
        </div>
      ) : recording ? (
        <div className={styles.rec}>
          <span className={styles.recDot} aria-hidden="true" /> recording — go do the thing
          <button type="button" className={styles.quiet} onClick={() => disarm.mutate()}>
            stop
          </button>
        </div>
      ) : (
        <button type="button" className={styles.arm} onClick={() => arm.mutate(90)} disabled={arm.isPending}>
          Record what I do next (90s)
        </button>
      )}
      <p className={styles.sub}>
        {live
          ? 'While the app is on screen, everything you do is a journey: the tap and the component it hit, each request and every file it crosses, the turn, the agent\u2019s tool calls, the reply stream — and every store write meanwhile. Background polls are left out. Off screen, nothing is traced. Kept a week.'
          : 'One id on everything the browser does for 90s. Pick a capture and the creek becomes it.'}
      </p>
      <ul className={styles.list}>
        {groups.map((g) => (
          <li key={g.key} className={styles.hour}>
            {g.label}
          </li>
        )).flatMap((hourRow, gi) => [
          hourRow,
          ...groups[gi].items.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={t.id === picked ? styles.rowActive : styles.row}
              onClick={() => onPick(t.id)}
            >
              <span className={styles.rowMain}>
                {t.kind === 'journey' ? 'journey' : t.entry}
                {t.label ? ` · ${t.label}` : ''}
              </span>
              <span className={styles.rowMeta}>
                {t.started_at.slice(0, 16).replace('T', ' ')} · {formatDuration(t.duration_us)}
                {t.truncated ? ' · truncated' : ''}
              </span>
            </button>
          </li>
          )),
        ])}
        {traces.data && list.length === 0 ? <li className={styles.sub}>No captures yet.</li> : null}
      </ul>
    </div>
  );
}

/** Newest first, bucketed by local hour — "today 14:00", "yesterday 09:00". */
function groupByHour<T extends { id: string; started_at: string }>(items: readonly T[]) {
  const out: { key: string; label: string; items: T[] }[] = [];
  const today = new Date().toDateString();
  const yday = new Date(Date.now() - 86_400_000).toDateString();
  for (const t of items) {
    const d = new Date(t.started_at);
    const key = Number.isNaN(d.getTime()) ? 'unknown' : `${d.toDateString()} ${d.getHours()}`;
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      const day = d.toDateString() === today ? 'today' : d.toDateString() === yday ? 'yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      g = { key, label: Number.isNaN(d.getTime()) ? 'undated' : `${day} ${String(d.getHours()).padStart(2, '0')}:00`, items: [] };
      out.push(g);
    }
    g.items.push(t);
  }
  return out;
}
