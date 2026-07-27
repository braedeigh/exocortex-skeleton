import { useId } from 'react';
import { HEAT_DAYS_MAX, HEAT_DAYS_MIN } from './terrainGraph';
import { POS_STEPS, posFromValue, valueFromPos } from './TerrainDials';
import styles from './TerrainHeatBar.module.css';

/**
 * TerrainHeatBar — the map's heat lens, as one slider instead of three chips.
 *
 * It sets the half-life: how fast a file's glow decays with age. Short, and
 * only the last few hours are lit; long, and the map remembers back a month.
 * This used to be three buttons (Day / Week / Month), which were always just
 * three presets — the heat math has taken a raw half-life all along (see
 * HeatSpan in terrainGraph.ts), so this is a new control over an old seam,
 * not a new capability.
 *
 * Three things worth knowing about the shape of it:
 *
 * 1. **The track is logarithmic**, like the Files dial next door and for the
 *    same reason: one day to one month is a 30x span, so a linear track would
 *    bunch the two most-used settings into its left fifth and spend most of
 *    its travel on the difference between three weeks and a month. On a log
 *    track the three presets land at 0%, ~57% and 100%.
 * 2. **A tick per day.** They crowd toward the long end, which is honest —
 *    that crowding IS the log compression, drawn rather than hidden. The three
 *    preset days are drawn taller so the anchors stay findable.
 * 3. **The presets are buttons that move the slider**, not a separate mode.
 *    There's one value here and one control over it; the buttons are shortcuts
 *    to points on the same track, and they light up when the slider is on them.
 *
 * Prompt that produced it: "change the day/week/month toggle for the heat map
 * coloring... a bar like the rest, but with tick marks for days, and a label
 * for 1 day, 1 week, and 1 month, which are clickable buttons that set the bar
 * to that."
 */

const PRESETS: readonly { days: number; label: string }[] = [
  { days: 1, label: '1 day' },
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
];

/** Where a given day sits along the log track, 0..100%. Shared by the tick
 * marks and nothing else — the input itself works in POS_STEPS. */
function trackPct(days: number): number {
  return (posFromValue(days, HEAT_DAYS_MIN, HEAT_DAYS_MAX) / POS_STEPS) * 100;
}

const TICK_DAYS = Array.from({ length: HEAT_DAYS_MAX }, (_, i) => i + 1);

export interface TerrainHeatBarProps {
  /** The half-life in whole days. */
  days: number;
  onDays: (days: number) => void;
}

export function TerrainHeatBar({ days, onDays }: TerrainHeatBarProps) {
  const id = useId();
  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <label className={styles.label} htmlFor={id}>
          Heat
        </label>
        <div className={styles.track}>
          <span className={styles.ticks} aria-hidden="true">
            {TICK_DAYS.map((d) => (
              <span
                key={d}
                className={[styles.tick, PRESETS.some((p) => p.days === d) ? styles.tickAnchor : '']
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: `${trackPct(d)}%` }}
              />
            ))}
          </span>
          <input
            id={id}
            className={styles.range}
            type="range"
            min={0}
            max={POS_STEPS}
            step={1}
            value={posFromValue(days, HEAT_DAYS_MIN, HEAT_DAYS_MAX)}
            onChange={(e) =>
              onDays(valueFromPos(Number(e.target.value), HEAT_DAYS_MIN, HEAT_DAYS_MAX))
            }
            aria-label="How far back the map stays lit (heat half-life)"
            aria-valuetext={`${days} ${days === 1 ? 'day' : 'days'}`}
          />
        </div>
      </div>
      <div className={styles.presets} role="group" aria-label="Heat presets">
        {PRESETS.map((p) => (
          <button
            key={p.days}
            type="button"
            className={[styles.preset, days === p.days ? styles.presetOn : ''].filter(Boolean).join(' ')}
            aria-pressed={days === p.days}
            onClick={() => onDays(p.days)}
          >
            {p.label}
          </button>
        ))}
        <span className={styles.readout}>
          {days} {days === 1 ? 'day' : 'days'}
        </span>
      </div>
    </div>
  );
}
