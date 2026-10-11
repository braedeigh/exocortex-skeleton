/**
 * JourneyPanel.tsx — the terrain's replay controls: record a journey, pick
 * one, play it on the map.
 *
 * Plain English: this is the small card the Journey chip opens. "Record"
 * arms a journey (the browser starts carrying the id on everything it does —
 * api/journey.ts); the list is every capture the server kept; "Play" hands
 * the chosen journey's beats to TerrainPage, which flashes dots and draws
 * threads on the canvas as they happened. The panel never touches the canvas
 * itself — it only turns a trace into beats (journeyReplay.ts) and reports
 * them up.
 *
 * Non-modal on purpose: a replay is watched on the map behind this card, so a
 * backdrop that dims the map would hide the thing being shown.
 */
import { useEffect, useMemo, useState } from 'react';
import { currentJourney, isLive, setLive, subscribeJourney } from '../../api/journey';
import { useArmJourney, useDisarmTrace, useTrace, useTraces } from './wiring/api';
import { formatDuration } from './wiring/wiringMath';
import { buildJourneyBeats, type Beat } from './journeyReplay';
import styles from './JourneyPanel.module.css';

export interface ReplayRequest {
  id: string;
  beats: Beat[];
  /** 1 = real time; 4 = four times slower. */
  slow: number;
}

export function JourneyPanel({
  open,
  onClose,
  initialId,
  onPlay,
  onStop,
  playing,
  progress,
}: {
  open: boolean;
  onClose: () => void;
  /** A journey to preselect — from `?journey=` when arriving from the Wiring room. */
  initialId: string | null;
  onPlay: (req: ReplayRequest) => void;
  onStop: () => void;
  playing: string | null;
  /** Beats played so far / total, while playing. */
  progress: { done: number; total: number; label: string } | null;
}) {
  const traces = useTraces();
  const arm = useArmJourney();
  const disarm = useDisarmTrace();
  const [picked, setPicked] = useState<string | null>(initialId);
  const [slow, setSlow] = useState(4);
  const trace = useTrace(picked);
  // Re-render when the browser half starts or stops, so "recording…" is live.
  const [, bump] = useState(0);
  useEffect(() => subscribeJourney(() => bump((n) => n + 1)), []);
  useEffect(() => {
    if (initialId) setPicked(initialId);
  }, [initialId]);

  const beats = useMemo(() => (trace.data ? buildJourneyBeats(trace.data) : []), [trace.data]);
  const withDot = useMemo(() => beats.filter((b) => b.nodeId).length, [beats]);

  if (!open) return null;
  const recording = currentJourney();
  const list = (traces.data?.traces ?? []).filter((t) => t.kind === 'journey' || t.kind === 'http');

  return (
    <div className={styles.panel} role="dialog" aria-label="Journey" data-journey-ui="">
      <header className={styles.head}>
        <span className={styles.title}>Journey</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <label className={styles.live}>
        <input type="checkbox" checked={isLive()} onChange={(e) => setLive(e.target.checked)} />
        <span><strong>Live</strong> — record while I&rsquo;m looking</span>
      </label>
      {isLive() ? (
        <div className={styles.recBox}>
          <span className={styles.recDot} aria-hidden="true" /> {recording ? 'recording this tab' : 'opening…'}
        </div>
      ) : recording || traces.data?.journey ? (
        <div className={styles.recBox}>
          <span className={styles.recDot} aria-hidden="true" /> recording — go do the thing
          <button type="button" className={styles.btnQuiet} onClick={() => disarm.mutate()}>
            stop
          </button>
        </div>
      ) : (
        <button type="button" className={styles.btn} onClick={() => arm.mutate(90)} disabled={arm.isPending}>
          Record what I do next (90s)
        </button>
      )}
      <p className={styles.sub}>
        Then come back here and play it: every dot the action touched flares in order, and the
        threads between them light as the data moves.
      </p>

      <ul className={styles.list}>
        {list.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={t.id === picked ? styles.rowActive : styles.row}
              onClick={() => setPicked(t.id)}
            >
              <span className={styles.rowMain}>
                {t.kind === 'journey' ? 'journey' : t.entry}
                {t.label ? ` · ${t.label}` : ''}
              </span>
              <span className={styles.rowMeta}>
                {t.started_at.slice(0, 16).replace('T', ' ')} · {formatDuration(t.duration_us)}
              </span>
            </button>
          </li>
        ))}
        {traces.data && list.length === 0 ? <li className={styles.sub}>No captures yet.</li> : null}
      </ul>

      {picked ? (
        <div className={styles.playBox}>
          <div className={styles.playMeta}>
            {trace.isLoading
              ? 'reading…'
              : `${beats.length} beats · ${withDot} on the map${beats.length - withDot ? ` · ${beats.length - withDot} with no dot` : ''}`}
          </div>
          <label className={styles.slow}>
            speed
            <select value={slow} onChange={(e) => setSlow(Number(e.target.value))}>
              <option value={1}>real time</option>
              <option value={4}>4× slower</option>
              <option value={10}>10× slower</option>
            </select>
          </label>
          {playing === picked ? (
            <button type="button" className={styles.btnQuiet} onClick={onStop}>
              stop
            </button>
          ) : (
            <button
              type="button"
              className={styles.btn}
              disabled={beats.length === 0}
              onClick={() => onPlay({ id: picked, beats, slow })}
            >
              Play on the map
            </button>
          )}
          {progress && playing === picked ? (
            <div className={styles.progress}>
              <div className={styles.bar} style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
              <span className={styles.now}>{progress.label}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
