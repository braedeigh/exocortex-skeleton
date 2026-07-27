import { useState } from 'react';
import styles from './TerrainAgentBar.module.css';

/**
 * TerrainAgentBar — the bottom agent control (her 07-26 spec):
 *
 *   [ Active ]  ◀──────█████──────▶   [ Agents · 8 ]
 *
 * - **Active** button: snap to only the agents open in the observatory right
 *   now; while it's on, the window is dimmed (one owner at a time).
 * - **The window**: a dual-handle slider over the roster ranked
 *   most-recent-first (running → open → last active). It slides over the
 *   *agent list itself*, not the calendar (that's the top Dates dial's job) —
 *   drag the handles to pull a band of past agents onto the map.
 * - **Agents button**: toggles a popup list of the agents currently shown —
 *   tap a row to spotlight that agent's footprint. No inline chips; the bar
 *   stays a control strip, the list is where identity lives.
 *
 * Selection/visibility state is owned by TerrainPage; this is presentation +
 * the two gestures. The dual-handle mechanics mirror TerrainDials' Dates row
 * exactly (only the thumbs take pointer events, so the handle you touch is the
 * one that moves).
 */

export interface AgentEntry {
  id: string;
  title: string;
  running: boolean;
  /** Open in the observatory right now. */
  active: boolean;
  files: number;
  last: number | null;
}

export interface TerrainAgentBarProps {
  /** Every agent on the map, ranked most-recent-first. */
  ranked: AgentEntry[];
  /** Ids actually shown right now (page computes from activeOnly + window). */
  shownIds: ReadonlySet<string>;
  activeOnly: boolean;
  onActiveOnly: (v: boolean) => void;
  /** Window over `ranked` by index, [from, to). Meaningful only when !activeOnly. */
  from: number;
  to: number;
  onWindow: (from: number, to: number) => void;
  /** The spotlighted agent id (footprint ringed on the map), or null. */
  spotlighted: string | null;
  onSpotlight: (id: string | null) => void;
}

export function TerrainAgentBar({
  ranked,
  shownIds,
  activeOnly,
  onActiveOnly,
  from,
  to,
  onWindow,
  spotlighted,
  onSpotlight,
}: TerrainAgentBarProps) {
  const [listOpen, setListOpen] = useState(false);

  const n = ranked.length;
  // Clamp the window to the current roster: a refetch can shrink `n` under a
  // handle that was parked further out.
  const wTo = Math.min(Math.max(to, 1), Math.max(1, n));
  const wFrom = Math.min(Math.max(from, 0), Math.max(0, wTo - 1));
  const pct = (i: number) => (n > 0 ? (i / n) * 100 : 0);

  const shownList = ranked.filter((a) => shownIds.has(a.id));

  return (
    <div className={styles.bar} role="group" aria-label="Agents">
      <button
        type="button"
        className={[styles.btn, activeOnly ? styles.btnOn : ''].filter(Boolean).join(' ')}
        aria-pressed={activeOnly}
        onClick={() => onActiveOnly(!activeOnly)}
        title={
          activeOnly
            ? 'Showing only the sessions open in your observatory — tap to slide through past agents'
            : 'Showing a window of past agents — tap for just your open sessions'
        }
      >
        Active
      </button>

      {/* The window over the ranked roster. Dimmed + inert while Active is on. */}
      <div
        className={[styles.window, activeOnly ? styles.windowDimmed : ''].filter(Boolean).join(' ')}
        aria-hidden={activeOnly}
      >
        <div className={styles.dualTrack}>
          <span
            className={styles.selected}
            style={{ left: `${pct(wFrom)}%`, right: `${100 - pct(wTo)}%` }}
            aria-hidden="true"
          />
          <input
            className={`${styles.range} ${styles.rangeDual}`}
            type="range"
            min={0}
            max={Math.max(1, n)}
            step={1}
            value={wFrom}
            disabled={activeOnly || n === 0}
            onChange={(e) => onWindow(Math.min(Number(e.target.value), wTo - 1), wTo)}
            aria-label="Newest agent shown"
          />
          <input
            className={`${styles.range} ${styles.rangeDual}`}
            type="range"
            min={0}
            max={Math.max(1, n)}
            step={1}
            value={wTo}
            disabled={activeOnly || n === 0}
            onChange={(e) => onWindow(wFrom, Math.max(Number(e.target.value), wFrom + 1))}
            aria-label="Oldest agent shown"
          />
        </div>
      </div>

      <div className={styles.listWrap}>
        <button
          type="button"
          className={[styles.btn, listOpen ? styles.btnOn : ''].filter(Boolean).join(' ')}
          aria-pressed={listOpen}
          aria-expanded={listOpen}
          onClick={() => setListOpen((v) => !v)}
        >
          Agents · {shownIds.size}
        </button>
        {listOpen ? (
          <div className={styles.pop} role="menu">
            {shownList.length === 0 ? (
              <div className={styles.popEmpty}>
                {activeOnly ? 'No sessions open' : 'No agents in range'}
              </div>
            ) : (
              shownList.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={spotlighted === a.id}
                  className={[styles.popRow, spotlighted === a.id ? styles.popRowOn : '']
                    .filter(Boolean)
                    .join(' ')}
                  title={`${a.files} ${a.files === 1 ? 'file' : 'files'} touched`}
                  onClick={() => onSpotlight(spotlighted === a.id ? null : a.id)}
                >
                  {a.running ? <span className={styles.runDot} aria-hidden="true" /> : null}
                  <span className={styles.popLabel}>{a.title}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
