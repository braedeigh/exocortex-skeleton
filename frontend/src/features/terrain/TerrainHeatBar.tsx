import { useId } from 'react';
import { HEAT_DAYS_MAX, HEAT_DAYS_MIN, heatTrackStops } from './terrainGraph';
import { HEAT_RAMP_DARK, HEAT_RAMP_LIGHT, heatColor } from './terrainCanvas';
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
 * Four things worth knowing about the shape of it:
 *
 * 1. **The track is logarithmic**, like the Files dial next door and for the
 *    same reason: one day to one year is a 365x span, so a linear track would
 *    bunch the most-used settings into its left sliver and spend most of its
 *    travel on the difference between ten months and twelve. On a log track
 *    the day/week/month/year presets land at roughly even strides.
 * 2. **The map's own colour ramp is painted along the track**, so the control
 *    IS the legend: read as an age axis, the colour under any point is what a
 *    file that old wears on the map right now. Drag right and the whole ramp
 *    brightens — that's a longer memory, shown rather than labelled. The
 *    sampling maths is heatTrackStops in terrainGraph.ts; the colours come
 *    from the same heatColor the canvas paints nodes with.
 * 3. **A tick per day, etched over the ramp.** They crowd toward the long end,
 *    which is honest — that crowding IS the log compression, drawn rather than
 *    hidden. The three preset days stand taller so the anchors stay findable.
 * 4. **The presets are buttons that move the slider**, not a separate mode.
 *    There's one value here and one control over it; the buttons are shortcuts
 *    to points on the same track, and they light up when the slider is on them.
 *    They sit ABOVE the track: this block is the top of the bottom-left stack
 *    now, so the buttons are the first thing the eye lands on coming down.
 * 5. **Dynamic is the one that isn't a point** — it hands the half-life to the
 *    same breath the Observatory backdrop runs on (breathHalfLife), swelling
 *    from a day out to a month and settling back once every ten seconds. It
 *    stays inside the "buttons move the slider" rule rather than breaking it:
 *    the page keeps feeding this component the breath's live value, so the
 *    thumb glides the track and the ramp brightens and dims under it. The mode
 *    is visible as motion on the control itself, not as a separate state the
 *    slider has to be switched out of. Touching the slider or any fixed preset
 *    takes the value back — the page turns breathing off on any onDays.
 *
 * Prompts that produced it: "change the day/week/month toggle for the heat map
 * coloring... a bar like the rest, but with tick marks for days, and a label
 * for 1 day, 1 week, and 1 month, which are clickable buttons that set the bar
 * to that." / "swap the ordering of the heat and the active agents bars... so
 * that heat is on top and the active agents is on bottom, with the buttons for
 * 1 day-week options on the top... i want the heat map to also be superimposed
 * onto the heat map bar." / "another button next to the '1 month' button that
 * is 'dynamic' and follows the heartbeat pattern on the background terrain."
 */

const PRESETS: readonly { days: number; label: string }[] = [
  { days: 1, label: '1 day' },
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 365, label: '1 year' },
];

/** Where a given day sits along the log track, 0..100%. Shared by the tick
 * marks and nothing else — the input itself works in POS_STEPS. */
function trackPct(days: number): number {
  return (posFromValue(days, HEAT_DAYS_MIN, HEAT_DAYS_MAX) / POS_STEPS) * 100;
}

/** The ruler: a tick per day out to a month, then a tick per 30 days to the
 * year end. Daily ticks past a month would smear into a solid bar on a log
 * track that now runs to 365 — the ruler switches to the unit the eye
 * actually reads at that distance, same instinct as formatAge's unit ladder. */
const TICK_DAYS = [
  ...Array.from({ length: 30 }, (_, i) => i + 1),
  ...Array.from({ length: 11 }, (_, i) => (i + 2) * 30),
  365,
];

export interface TerrainHeatBarProps {
  /** The half-life in days. Whole days when she set it; fractional while the
   * breath is driving, so the thumb glides instead of stepping. */
  days: number;
  /** Any call to this ends the breath — the page owns that rule. */
  onDays: (days: number) => void;
  /** Which ramp to paint — the two differ only at the cold end, which has to
   * sit just above whichever surface it's on. Undefined before the theme has
   * resolved; dark is the map's usual home. */
  dark?: boolean;
  /** True while the half-life is riding the breath. */
  breathing?: boolean;
  onBreathe?: () => void;
}

export function TerrainHeatBar({
  days,
  onDays,
  dark = true,
  breathing = false,
  onBreathe,
}: TerrainHeatBarProps) {
  const id = useId();
  // The ramp along the track, hot (today) on the left to cold (a month back)
  // on the right — the same colours, from the same lookup, as the nodes.
  const ramp = dark ? HEAT_RAMP_DARK : HEAT_RAMP_LIGHT;
  const gradient = `linear-gradient(to right, ${heatTrackStops(days)
    .map((s) => `${heatColor(s.t, ramp)} ${s.pct.toFixed(1)}%`)
    .join(', ')})`;
  return (
    <div className={styles.bar}>
      <div className={styles.presets} role="group" aria-label="Heat presets">
        {PRESETS.map((p) => (
          <button
            key={p.days}
            type="button"
            className={[styles.preset, !breathing && days === p.days ? styles.presetOn : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={!breathing && days === p.days}
            onClick={() => onDays(p.days)}
          >
            {p.label}
          </button>
        ))}
        {/* Lit, this pill breathes on the same 10s clock as the value it's
            driving — so the control is doing the thing it turned on, and you
            can read the mode off the button without watching the map. */}
        <button
          type="button"
          className={[styles.preset, breathing ? `${styles.presetOn} ${styles.presetBreathing}` : '']
            .filter(Boolean)
            .join(' ')}
          aria-pressed={breathing}
          onClick={() => onBreathe?.()}
          title="Let the half-life breathe — a day out to a month and back"
        >
          Dynamic
        </button>
        <span className={styles.readout}>
          {Math.round(days)} {Math.round(days) === 1 ? 'day' : 'days'}
        </span>
      </div>
      <div className={styles.row}>
        <label className={styles.label} htmlFor={id}>
          Heat
        </label>
        <div className={styles.track}>
          {/* The ramp and the ruler are their own elements UNDER the input,
              rather than a background on the input's track pseudo-element, so
              the thumb still paints over both — a tick drawn on top of the
              handle would strike a white line straight through it. */}
          <span className={styles.ramp} style={{ background: gradient }} aria-hidden="true" />
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
    </div>
  );
}
