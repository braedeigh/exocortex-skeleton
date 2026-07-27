import { useId } from 'react';
import styles from './TerrainDials.module.css';

/**
 * TerrainDials — the two sliders above the map.
 *
 *   Files  how many file nodes to draw, 1 → every file there is
 *   Dates  the span to draw them from, two handles
 *
 * There was a third, "Window" ("last 21 days"), as a one-handed shortcut for
 * setting Dates to a span ending now. It's gone: it could only ever express
 * ranges Dates could already express, so it was a second control over one
 * value — and two rows that can disagree about the same thing is a bug
 * surface, not a convenience. Dates is now the single source of truth for
 * time, and dragging its end handle to today does what Window did.
 *
 * Each slider's readout sits directly beneath its own track, so the number
 * belongs to the thing above it rather than to a column off to the side.
 *
 * Touch rules (CLAUDE.md): every track is a 40px grab strip with a 28px
 * thumb, and no label under 12px.
 */

/** Count and day dials both span a wide range whose interesting part is
 * bunched at the bottom (1–500 files matters more finely than 2,500–3,000),
 * so the slider position is logarithmic. Positions are 0..POS_STEPS integers
 * — the input's own step granularity, independent of the value range.
 *
 * 10,000 rather than 100: a log scale's steps are *relative*, so a coarse
 * track quantizes the top of the range into jumps of several files at a time
 * (at 1,000 steps across ~3,300 files, one notch near the top moved ~27).
 * This is a plain integer knob, so the extra resolution costs nothing. */
export const POS_STEPS = 10000;

export function posFromValue(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  const lmin = Math.log(min);
  const span = Math.log(max) - lmin;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round((POS_STEPS * (Math.log(clamped) - lmin)) / span);
}

export function valueFromPos(pos: number, min: number, max: number): number {
  if (max <= min) return min;
  const lmin = Math.log(min);
  const span = Math.log(max) - lmin;
  return Math.round(Math.exp(lmin + (pos / POS_STEPS) * span));
}

const DAY = 86400;

/**
 * The date handles step in whole *local* days, not UTC ones. Snapping on
 * `Math.floor(seconds / 86400)` would put every boundary at 00:00 UTC —
 * 7pm the previous evening in Austin — so a handle labeled "Jul 10" would
 * really mean "from Jul 9, 7pm", and the label would disagree with the map.
 *
 * So: day 0 is local midnight of the earliest touch, and every handle
 * position is a whole number of days from there. (A DST shift makes one of
 * those days 23 or 25 hours long; for a date filter reading whole days that
 * is invisible, and worth far less than the off-by-a-day this avoids.)
 */
export function startOfLocalDay(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

/** "Jul 3" / "Jul 3, 2025" — the year only when it isn't the current one. */
export function formatDay(unixSeconds: number, nowSeconds = Date.now() / 1000): string {
  const d = new Date(unixSeconds * 1000);
  const sameYear = d.getFullYear() === new Date(nowSeconds * 1000).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export interface TerrainDialsProps {
  /** File nodes actually drawn right now. Reported rather than the requested
   * count, so the row can never claim more than the map is showing (asking
   * for 3,000 inside a one-day window honestly reads as the handful that
   * exist there). */
  shown: number;
  /** Every file in the window, including ones the server cut. */
  totalFiles: number;
  count: number;
  onCount: (n: number) => void;
  /** True while a bigger tier is in flight, so the row can say so. */
  loadingMore?: boolean;

  /** Range bounds — the oldest touch in the payload, and now. */
  earliest: number;
  now: number;
  from: number;
  to: number;
  onRange: (from: number, to: number) => void;
}

export function TerrainDials({
  shown,
  totalFiles,
  count,
  onCount,
  loadingMore = false,
  earliest,
  now,
  from,
  to,
  onRange,
}: TerrainDialsProps) {
  const filesId = useId();
  const datesId = useId();

  const countMax = Math.max(1, totalFiles);

  // Handle positions are whole days counted from local midnight of the
  // earliest touch (see startOfLocalDay). Index, not timestamp, so the two
  // handles can never land mid-day and read as the same date.
  const origin = startOfLocalDay(earliest);
  const dayIndex = (seconds: number) => Math.round((startOfLocalDay(seconds) - origin) / DAY);
  /** Index → the instant that day *starts*, for the range's `from` edge. */
  const dayStart = (index: number) => origin + index * DAY;
  /** Index → the last instant of that day, so a range ending "Jul 10"
   * actually includes everything that happened on Jul 10. */
  const dayEnd = (index: number) => origin + (index + 1) * DAY - 1;

  const dayMin = 0;
  const dayMax = Math.max(1, dayIndex(now));
  const fromDay = Math.min(Math.max(dayIndex(from), dayMin), dayMax);
  const toDay = Math.min(Math.max(dayIndex(to), dayMin), dayMax);

  return (
    <div className={styles.dials}>
      {/* --- Files ---------------------------------------------------- */}
      <div className={styles.row}>
        <label className={styles.label} htmlFor={filesId}>
          Files
        </label>
        {/* Filled like a fuel gauge: the purple length IS how many files are
            drawn, the grey remainder is how many more there are to ask for.
            Built as a lit span over a grey line — the same two elements the
            Dates row below uses — rather than a gradient on the track, so
            there's one filling technique in this file instead of two. */}
        <div className={`${styles.track} ${styles.fillTrack}`}>
          <span
            className={styles.selected}
            style={{ left: 0, right: `${100 - (posFromValue(count, 1, countMax) / POS_STEPS) * 100}%` }}
            aria-hidden="true"
          />
          <input
            id={filesId}
            className={`${styles.range} ${styles.rangeFilled}`}
            type="range"
            min={0}
            max={POS_STEPS}
            step={1}
            value={posFromValue(count, 1, countMax)}
            onChange={(e) => onCount(valueFromPos(Number(e.target.value), 1, countMax))}
            aria-label="How many files to draw"
            aria-valuetext={`${formatCount(count)} of ${formatCount(totalFiles)} files`}
          />
        </div>
        <div className={styles.readout}>
          <span className={styles.value}>
            {formatCount(shown)} of {formatCount(totalFiles)}
          </span>
          {loadingMore ? <span className={styles.note}>loading more…</span> : null}
        </div>
      </div>

      {/* --- Dates: two handles over one track ------------------------ */}
      <div className={styles.row}>
        <label className={styles.label} htmlFor={datesId}>
          Dates
        </label>
        <div className={`${styles.track} ${styles.dualTrack}`}>
          {/* The selected span, drawn between the handles. */}
          <span
            className={styles.selected}
            style={{
              left: `${((fromDay - dayMin) / Math.max(1, dayMax - dayMin)) * 100}%`,
              right: `${100 - ((toDay - dayMin) / Math.max(1, dayMax - dayMin)) * 100}%`,
            }}
            aria-hidden="true"
          />
          <input
            id={datesId}
            className={`${styles.range} ${styles.rangeDual}`}
            type="range"
            min={dayMin}
            max={dayMax}
            step={1}
            value={fromDay}
            onChange={(e) => {
              // Handles can't cross: the start stays at least a day below the end.
              const next = Math.max(dayMin, Math.min(Number(e.target.value), toDay - 1));
              onRange(dayStart(next), dayEnd(toDay));
            }}
            aria-label="Range start"
            aria-valuetext={formatDay(dayStart(fromDay), now)}
          />
          <input
            className={`${styles.range} ${styles.rangeDual}`}
            type="range"
            min={dayMin}
            max={dayMax}
            step={1}
            value={toDay}
            onChange={(e) => {
              const next = Math.min(dayMax, Math.max(Number(e.target.value), fromDay + 1));
              onRange(dayStart(fromDay), dayEnd(next));
            }}
            aria-label="Range end"
            aria-valuetext={formatDay(dayEnd(toDay), now)}
          />
        </div>
        <div className={styles.readout}>
          <span className={styles.value}>
            {formatDay(dayStart(fromDay), now)} → {formatDay(dayEnd(toDay), now)}
          </span>
        </div>
      </div>
    </div>
  );
}
