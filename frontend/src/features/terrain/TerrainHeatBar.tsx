import { useId } from 'react';
import { formatAge, HEAT_DAYS_MAX, HEAT_DAYS_MIN, heatTrackStops } from './terrainGraph';
import { GOLD_RAMP_LIGHT, HEAT_RAMP_LIGHT, heatColor } from './terrainCanvas';
import { POS_STEPS, posFromValue, valueFromPos } from './TerrainDials';
import {
  ACTIVE_ANCHOR_SECONDS,
  ACTIVE_MAX_SECONDS,
  ACTIVE_MIN_SECONDS,
  ACTIVE_TICK_SECONDS,
  activePct,
  posFromSeconds,
  secondsFromPos,
} from './activeScale';
import styles from './TerrainHeatBar.module.css';

/**
 * TerrainHeatBar — the map's two fires, one bar each.
 *
 *   [1 day][1 week][1 month][1 year][Dynamic]      [Types]
 *   Heat    ▓▓▓▓▓▓●─────────────────────────────    7d
 *   Active  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓●─────────────────   1d
 *
 * The map burns in two colours and they answer different questions: EMBER is
 * EDITING, GOLD is RUNNING. There is one bar for each, stacked, and neither
 * says anything about the other's fire.
 *
 * - **Heat** (ember, red) sets how far back an EDIT stays lit — one day out
 *   to one year.
 * - **Active** (gold, yellow) sets how recently a file must have RUN to stay
 *   lit — five minutes out to one week (activeScale.ts). Its switch also
 *   rings those files on the map.
 *
 * On both, the thumb is the EDGE of the colour: fully lit now, half lit a
 * third of the way along, gone at the dot (terrainGraph.ts windowToHalfLife
 * has the arithmetic).
 *
 * This read as three bars until recently. Gold rode a second, thinner band
 * squeezed under ember's on the Heat row, marked by a ring rather than a thumb
 * because its window was pinned at a day and wasn't hers to set — while the
 * bar actually ABOUT runs sat underneath wearing no colour at all. Two fires
 * sharing one row read as one instrument with a mystery on it. Now each fire
 * owns a whole bar, and the bar named Active is the gold one: its slider sets
 * gold's window on the map, not just the halo's.
 * Prompt: "the 'third' one should be the 'second' one and there should only be
 * 2 total and they should be separate such that there is a heat bar and an
 * activity bar only."
 *
 * Some things worth knowing about the shape of it:
 *
 * 1. **Both tracks are logarithmic**, like the Files dial next door and for
 *    the same reason: one day to one year is a 365x span, and five minutes to
 *    a week is a 2016x one, so a linear track would bunch the most-used
 *    settings into its left sliver and spend most of its travel on the
 *    difference between ten months and twelve. On a log track Heat's
 *    day/week/month/year presets land at roughly even strides, and Active
 *    gives real travel to minutes.
 * 2. **Each bar carries its own fire's ramp, so the control IS the legend.**
 *    Read a track as an age axis and the colour under any point is what a file
 *    that old wears on the map right now; past the thumb it's ash. Drag right
 *    and the fill lengthens — a longer memory, shown rather than labelled. The
 *    sampling maths is heatTrackStops in terrainGraph.ts (it speaks days, so
 *    the Active bar hands it its own span converted to days); the colours come
 *    from the same heatColor the canvas paints nodes with.
 * 3. **A ruler per bar, in that bar's own unit.** Heat: a tick per day out to
 *    a month, then a tick per 30 days to the year, with the four preset days
 *    standing taller. Active: quarter-hours through the first hour, then
 *    hourly to a day, then daily to the week, with the hour / day / week
 *    standing taller (activeScale.ts ACTIVE_TICK_SECONDS). Both crowd toward
 *    their long end, which is honest — that crowding IS the log compression,
 *    drawn rather than hidden.
 * 4. **The presets are buttons that move the Heat slider**, not a separate
 *    mode. There's one value there and one control over it; the buttons are
 *    shortcuts to points on the same track, and they light up when the slider
 *    is on them. They sit ABOVE the tracks: this block is the top of the
 *    bottom-left stack, so the buttons are the first thing the eye lands on
 *    coming down.
 * 5. **Dynamic is the one that isn't a point** — it hands both windows to the
 *    same breath the Observatory backdrop runs on, and the two fires take
 *    TURNS (terrainGraph.ts alternatingBreath), each resting at its smallest.
 *    For one ten-second cycle the Heat thumb swells out to a month and
 *    returns while Active rests at five minutes; the next, the Active thumb
 *    swells out to a day and returns while Heat rests at a day. One thumb
 *    moving at a time, on its own bar, is the whole mode made visible — you
 *    can read which fire has the breath without looking at the map. It stays
 *    inside the "buttons move the slider" rule rather than breaking it: the
 *    page keeps feeding this component both live values. Touching either
 *    slider, or any fixed preset, takes the value back.
 *    Prompts: "i want it to show like what has run in the past minute up to
 *    the past day" → "have one breath be the time of editing, then the other
 *    breath be the time of the last activated, and then have them alternate"
 *    → "when the red is at its smallest, the yellow is at its largest."
 * 6. **The two axes are not comparable by eye, on purpose.** Heat runs days
 *    out to a year; Active runs five minutes out to a week. They answer
 *    different questions in different units, and Active's is the one measured
 *    in minutes and hours. This overturns an earlier decision to put both on
 *    one ruler so the two edges could be compared; that comparison turned out
 *    to be worth less than being able to aim the Active thumb at "the last
 *    half hour". Active's floor is five minutes because that's the run
 *    sensor's bucket size (runtime_sensor.py BUCKET_SEC) — finer than that,
 *    the signal can't honestly speak.
 *    Prompts: "i want for the active to be a 24 hour toggle with minutes and
 *    hours marks instead of what it is now that matches heat" → "it should
 *    toggle 24 hours to one week or something on a condensed scale past 24
 *    hours and up to minutes on the left".
 * 7. **Types is a switch, not a preset.** It sits at the end of the same row
 *    because it answers the same question — how the map is lit — but it
 *    doesn't move either slider: on, every file dot wears its file type's
 *    GitHub colour and the heat HUES are overridden (terrainCanvas.ts). The
 *    sliders still work underneath it, and in two ways: heat sets dot SIZE,
 *    and it sets how much of the type colour is left (terrainCanvas.ts
 *    staleTypeColor) — a fresh file wears its colour whole, a stale one sinks
 *    into the sky and is gone by the thumb, and the lines into it recede with
 *    it as far as half (staleTypeAlpha), so the limb goes quiet together but
 *    the tree's shape survives. Folders take it too: a hollow folder's
 *    outline is split between the file types beneath it, each taking the
 *    share its count earns (folderTypes.ts), and the folder fades out with
 *    its contents — a branch with nothing live left in it goes entirely,
 *    label and lines included. So under Types the Heat thumb is a staleness
 *    dial: drag it right and older files come back. A gap sets it apart from
 *    the presets so it doesn't read as a fifth window. The value itself lives
 *    in typeColorPref.ts and stays on across reloads.
 *    Prompts: "a toggle to color the dots by file type like with the github
 *    scheme … that overrides the other colors when i toggle it on" → "i want
 *    to hide stale files … the dots turn black or disappear when i am on the
 *    'types' display" → "the lines that go to the dots faded too … to show
 *    they're 'there' but not be so prominent as the others".
 * 8. **One switch on this bar, and it only ever ADDS light.** The pill
 *    reading "Active" is a button: lit, every file that RAN inside the Active
 *    slider's window wears a gold halo on the map; hollow, nothing is marked.
 *    The switch sits where you already look to see which bar you're on. The
 *    slider beside it works either way — it is gold's window whether or not
 *    the halo is drawn.
 *
 *    "Heat" is NOT a switch. It used to be one — lit, it cut the map to
 *    "only what's still lit" — and that is gone: heat COLOURS the map and
 *    does not decide what's on it. One bar lights, one bar colours, and
 *    neither takes dots away.
 *    Prompt: "the heat map one should be the heat map alone and not the
 *    activity toggle".
 *
 *    The halo is additive rather than a cut, and that was a correction. As a
 *    cut it was savage: runs are Python-only (routes/terrain.py — the sensor
 *    can't see the browser), so "show only what ran lately" blanked every
 *    .tsx, .css, .md and .json dot on the map and left dozens out of
 *    thousands. Adding light says the same thing and costs nothing.
 *    Prompt: "i just want them to glow, not hide anything".
 *
 *    Nothing on this bar can move the layout, and nothing on it hides a dot
 *    any more either. The rule is runGlow.ts, handed to the canvas as a set
 *    to light up (terrainCanvas.ts setGlowFiles). The switch is off by
 *    default and lives on both views — heat and Types — each keeping its own,
 *    so a window set up under Types doesn't follow her back to the heat map.
 *    Not remembered across reloads, unlike Types: Types is how she likes the
 *    map lit; this is a question she's asking right now.
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

/** Where a given day sits along the ember track, 0..100%. Shared by the tick
 * marks and nothing else — the input itself works in POS_STEPS. */
function trackPct(days: number): number {
  return (posFromValue(days, HEAT_DAYS_MIN, HEAT_DAYS_MAX) / POS_STEPS) * 100;
}

const DAY_SECONDS = 24 * 3600;

/** The Active bar's ends in DAYS. heatTrackStops speaks days, and the gold
 * ramp is now painted along Active's own five-minutes-to-a-week span
 * (activeScale.ts) — same log mapping activePct uses, so the gradient and the
 * ruler land on the same positions. */
const ACTIVE_MIN_DAYS = ACTIVE_MIN_SECONDS / DAY_SECONDS;
const ACTIVE_MAX_DAYS = ACTIVE_MAX_SECONDS / DAY_SECONDS;

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
  /** The window in days. Whole days when she set it; fractional while the
   * breath is driving, so the thumb glides instead of stepping. */
  days: number;
  /** Any call to this ends the breath — the page owns that rule. */
  onDays: (days: number) => void;
  /** The ember ramp to paint along the track — the page hands over
   * heatRamps(ink).ember, whose cold end is derived from the live surface
   * (ash on dark), so it can't be picked from a flag here. Undefined before
   * the theme has resolved; falls back to the light ramp for that frame. */
  ramp?: readonly string[];
  /** The gold ramp, painted along the Active bar's track. Same provenance as
   * `ramp`: heatRamps(ink).gold from the page. */
  goldRamp?: readonly string[];
  /** True while the half-life is riding the breath. */
  breathing?: boolean;
  onBreathe?: () => void;
  /** True while file dots are coloured by file type instead of heat (note 7). */
  typeColors?: boolean;
  onTypeColors?: (on: boolean) => void;
  /** The Active bar: whether the halo is on, and gold's window in SECONDS
   * (notes 6 and 8). Seconds rather than days because this axis runs down to
   * five minutes, where a whole number of days has no resolution left. Whole
   * when she set it, fractional while the gold breath is driving. */
  activeGlow?: boolean;
  onActiveGlow?: (on: boolean) => void;
  activeSeconds?: number;
  /** Any call to this ends the breath, exactly like onDays — one value, one
   * owner, on both bars. */
  onActiveSeconds?: (seconds: number) => void;
}

/** The ramp laid along a log track for one window, as a CSS gradient. */
function trackGradient(
  days: number,
  ramp: readonly string[],
  minDays: number = HEAT_DAYS_MIN,
  maxDays: number = HEAT_DAYS_MAX,
): string {
  return `linear-gradient(to right, ${heatTrackStops(days, minDays, maxDays)
    .map((s) => `${heatColor(s.t, ramp)} ${s.pct.toFixed(1)}%`)
    .join(', ')})`;
}

export function TerrainHeatBar({
  days,
  onDays,
  ramp = HEAT_RAMP_LIGHT,
  goldRamp = GOLD_RAMP_LIGHT,
  breathing = false,
  onBreathe,
  typeColors = false,
  onTypeColors,
  activeGlow = false,
  onActiveGlow,
  activeSeconds = 86400,
  onActiveSeconds,
}: TerrainHeatBarProps) {
  const id = useId();
  const activeId = useId();
  // The fill along each track, hot (just now) on the left and running out at
  // that bar's thumb — the same colours, from the same lookup, as the nodes.
  const gradient = trackGradient(days, ramp);
  const goldGradient = trackGradient(
    activeSeconds / DAY_SECONDS,
    goldRamp,
    ACTIVE_MIN_DAYS,
    ACTIVE_MAX_DAYS,
  );
  const goldHot = goldRamp[goldRamp.length - 1];
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
          title="Let the windows breathe in turn — one breath reaches back a month of edits, the next widens from the last five minutes of runs out to the day"
        >
          Dynamic
        </button>
        {/* Colour the dots by file type instead of heat, stale ones fading
            out (note 7). A switch, so it reports pressed/unpressed rather
            than picking a window. */}
        {onTypeColors ? (
          <button
            type="button"
            className={[styles.preset, styles.presetApart, typeColors ? styles.presetOn : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={typeColors}
            onClick={() => onTypeColors(!typeColors)}
            title="Colour every file dot by its file type, in GitHub's colours, instead of by heat — stale files fade into the sky, gone by the thumb"
          >
            Types
          </button>
        ) : null}
      </div>
      <div className={styles.row}>
        {/* Heat's name is only a name (note 8). It was a switch once, cutting
            the map to what was still lit; now heat colours and nothing else,
            so this is a label — a pill that looked pressable but wasn't would
            be a lie about what the bar can do. */}
        <span className={styles.cutLabel}>Heat</span>
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
            aria-label="How far back the map stays lit"
            aria-valuetext={`${days} ${days === 1 ? 'day' : 'days'}`}
          />
        </div>
        {/* Each bar's readout sits beside that bar, the way TerrainDials puts
            every number with its own track — so a figure belongs to the thing
            next to it rather than to a column off in the corner. A dot in this
            bar's fire colour before the number says which fire it's the window
            for, without leaning on the row's label. */}
        <span className={styles.readout}>
          <span className={styles.readoutDot} style={{ background: ramp[ramp.length - 1] }} />
          {Math.round(days)}d
        </span>
      </div>
      {/* The Active bar (notes 6 and 8): gold's own question on gold's own
          ruler — five minutes to a week, in minutes and hours, not Heat's
          days. Built exactly like the Heat bar above it, ramp and all, because
          it is the other fire and not a lesser control. Lit, the files that ran
          inside this window also wear a gold halo; nothing is ever hidden. */}
      <div className={styles.row}>
        <button
          type="button"
          className={[styles.cutButton, activeGlow ? styles.cutOn : ''].filter(Boolean).join(' ')}
          aria-pressed={activeGlow}
          onClick={() => onActiveGlow?.(!activeGlow)}
          title="Ring every file that has RUN inside this window in gold. Nothing is hidden — running is what the map's gold fire means, and this puts a window on it"
        >
          Active
        </button>
        <div className={styles.track}>
          <span className={styles.ramp} style={{ background: goldGradient }} aria-hidden="true" />
          <span className={styles.ticks} aria-hidden="true">
            {ACTIVE_TICK_SECONDS.map((seconds) => (
              <span
                key={seconds}
                className={[styles.tick, ACTIVE_ANCHOR_SECONDS.has(seconds) ? styles.tickAnchor : '']
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: `${activePct(seconds)}%` }}
              />
            ))}
          </span>
          <input
            id={activeId}
            className={styles.range}
            type="range"
            min={0}
            max={POS_STEPS}
            step={1}
            value={posFromSeconds(activeSeconds)}
            onChange={(e) => onActiveSeconds?.(secondsFromPos(Number(e.target.value)))}
            aria-label="How recently a file must have run to stay lit"
            aria-valuetext={formatAge(activeSeconds)}
          />
        </div>
        {/* The window this bar is set to, readable whether or not the switch
            is lit — a setting you can't see is one you have to turn on to
            find. Same grammar as the Heat readout above: a dot in this bar's
            fire colour, then the number. */}
        <span className={styles.readout}>
          <span className={styles.readoutDot} style={{ background: goldHot }} />
          {formatAge(activeSeconds)}
        </span>
      </div>
    </div>
  );
}
