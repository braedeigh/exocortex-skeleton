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
 *           [1 day|1 week|1 month|1 year|Dynamic]      [Types]
 *   (Heat)   ▓▓▓▓▓▓●─────────────────────────────    7d  [All time]
 *   (Active) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓●─────────────────   1d  [All time]
 *
 * The map burns in two colours and they answer different questions: EMBER is
 * EDITING, GOLD is RUNNING. There is one bar for each, stacked, and neither
 * says anything about the other's fire.
 *
 * - **Heat** (ember, red) sets how far back an EDIT stays lit — one day out
 *   to one year.
 * - **Active** (gold, yellow) sets how recently a file must have RUN to stay
 *   lit — five minutes out to one week (activeScale.ts).
 *
 * Each bar's name is that fire's on/off switch (note 8), and each bar ends in
 * an "All time" button (note 9).
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
 *    coming down. They're drawn as a SEGMENTED CONTROL — one rectangle split
 *    by lines — because only one of them can be chosen at a time, and one
 *    shared outline says that better than five separate buttons do.
 *    Prompt: "i want all those buttons to be made into like, one rectangle
 *    separated by lines".
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
 *    sliders still work underneath it: they set how much of the type colour
 *    is left (terrainCanvas.ts staleTypeColor) — a fresh file wears its colour whole, a stale one sinks
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
 * 8. **Each bar's name is its fire's switch.** Press "Heat" and the red
 *    goes off the map entirely; press "Active" and the gold does. Lit (the
 *    tinted button) means that fire is painting; hollow means it isn't, and the
 *    bar dims to say so. The slider still works while its fire is off, so the
 *    window is where she left it when she turns it back on. Off is off
 *    everywhere that fire shows: an unlit fire adds nothing to a dot's colour
 *    (file dots are sized by bytes, not heat, so their size never changes),
 *    nor to a folder's size, and with gold off the threads (which are gold's ink) go
 *    too. With both off the map is plain ash — the structure alone. Under
 *    Types the fires are what "stale" is measured by, so turning one off
 *    leaves the other to decide what fades, and turning both off stops the
 *    fade and shows every type colour whole (terrainCanvas.ts staleFade).
 *    Neither switch hides a dot or moves the layout.
 *
 *    This replaces the old arrangement, where "Heat" was a plain label and
 *    "Active" drew an extra gold ring around files that ran. The ring is
 *    gone: once the name means "this fire, on or off", a second gold effect
 *    on the same button would be two meanings for one press.
 *    Prompt: "when you click heat or active, it toggles that color off or on
 *    completely rather than what exists now" → "drop the ring".
 * 9. **"All time" ends each bar.** It sits past the readout, at the track's
 *    far end, because that is where "further back" already points. Pressed, the
 *    window reaches back to the oldest thing that fire has on record — the
 *    oldest edit in the payload for Heat, the oldest run for Active — so the
 *    fade spreads over the whole history instead of stopping at the thumb. The
 *    page works that number out and feeds it in as the live value, and the
 *    readout shows it. For Active "all time" can be short: runs are
 *    Python-only and the sensor keeps a file's last 50 five-minute buckets
 *    (terrainGraph.ts terrainEarliestRun). Pressing it again, touching the
 *    slider, a preset or Dynamic all hand the window back. Turning it ON also
 *    switches that bar's fire on — asking to see all of a colour's history
 *    while the colour is off would show nothing.
 *    Prompts: "on the right, i want a button on each bar that says 'all
 *    time'" → "when i toggle all time on, it automatically toggles that bar
 *    on".
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
  /** Whether each fire is painting on the map — the bar names are these
   * switches (note 8). */
  heatOn?: boolean;
  onHeatOn?: (on: boolean) => void;
  activeOn?: boolean;
  onActiveOn?: (on: boolean) => void;
  /** Whether each bar is on "All time" (note 9). While it is, `days` /
   * `activeSeconds` already carry the all-time window the page worked out. */
  heatAllTime?: boolean;
  onHeatAllTime?: (on: boolean) => void;
  activeAllTime?: boolean;
  onActiveAllTime?: (on: boolean) => void;
  /** Gold's window in SECONDS (note 6). Seconds rather than days because this
   * axis runs down to five minutes, where a whole number of days has no
   * resolution left. Whole when she set it, fractional while the gold breath
   * is driving. */
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
  heatOn = true,
  onHeatOn,
  activeOn = true,
  onActiveOn,
  heatAllTime = false,
  onHeatAllTime,
  activeAllTime = false,
  onActiveAllTime,
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
  // A preset only reads as chosen when the slider is really sitting on it —
  // not while Dynamic or All time is driving the window.
  const heatFixed = !breathing && !heatAllTime;
  return (
    <div className={styles.bar}>
      <div className={styles.presets}>
        {/* The window presets as one segmented control (note 4): a single
            outline, split by lines, because exactly one of these is chosen. */}
        <div className={styles.segmented} role="group" aria-label="Heat presets">
          {PRESETS.map((p) => (
            <button
              key={p.days}
              type="button"
              className={[styles.segment, heatFixed && days === p.days ? styles.segmentOn : '']
                .filter(Boolean)
                .join(' ')}
              aria-pressed={heatFixed && days === p.days}
              onClick={() => onDays(p.days)}
            >
              {p.label}
            </button>
          ))}
          {/* Lit, this segment breathes on the same 10s clock as the value
              it's driving — so the control is doing the thing it turned on,
              and you can read the mode off the button without watching the
              map. */}
          <button
            type="button"
            className={[styles.segment, breathing ? `${styles.segmentOn} ${styles.presetBreathing}` : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={breathing}
            onClick={() => onBreathe?.()}
            title="Let the windows breathe in turn — one breath reaches back a month of edits, the next widens from the last five minutes of runs out to the day"
          >
            Dynamic
          </button>
        </div>
        {/* Colour the dots by file type instead of heat, stale ones fading
            out (note 7). A switch, so it reports pressed/unpressed rather
            than picking a window — and it stands outside the segmented
            control for the same reason. */}
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
      <div className={[styles.row, heatOn ? '' : styles.rowOff].filter(Boolean).join(' ')}>
        {/* Heat's name is the red fire's on/off switch (note 8). */}
        <button
          type="button"
          className={[styles.cutButton, heatOn ? styles.cutOn : ''].filter(Boolean).join(' ')}
          aria-pressed={heatOn}
          onClick={() => onHeatOn?.(!heatOn)}
          title="Turn the red (edited) colour on or off across the whole map"
        >
          Heat
        </button>
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
            aria-valuetext={`${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`}
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
        {/* Reach back to the oldest edit on record (note 9). */}
        <button
          type="button"
          className={[styles.preset, heatAllTime && !breathing ? styles.presetOn : '']
            .filter(Boolean)
            .join(' ')}
          aria-pressed={heatAllTime && !breathing}
          onClick={() => onHeatAllTime?.(!(heatAllTime && !breathing))}
          title="Stretch the red back to the oldest edit on record"
        >
          All time
        </button>
      </div>
      {/* The Active bar (notes 6 and 8): gold's own question on gold's own
          ruler — five minutes to a week, in minutes and hours, not Heat's
          days. Built exactly like the Heat bar above it, ramp, switch and all,
          because it is the other fire and not a lesser control. */}
      <div className={[styles.row, activeOn ? '' : styles.rowOff].filter(Boolean).join(' ')}>
        {/* Active's name is the gold fire's on/off switch (note 8). */}
        <button
          type="button"
          className={[styles.cutButton, activeOn ? styles.cutOn : ''].filter(Boolean).join(' ')}
          aria-pressed={activeOn}
          onClick={() => onActiveOn?.(!activeOn)}
          title="Turn the gold (ran) colour on or off across the whole map"
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
        {/* The window this bar is set to, readable whether or not its fire is
            on — a setting you can't see is one you have to turn on to find.
            Same grammar as the Heat readout above: a dot in this bar's fire
            colour, then the number. */}
        <span className={styles.readout}>
          <span className={styles.readoutDot} style={{ background: goldHot }} />
          {formatAge(activeSeconds)}
        </span>
        {/* Reach back to the oldest run on record (note 9). */}
        <button
          type="button"
          className={[styles.preset, activeAllTime && !breathing ? styles.presetOn : '']
            .filter(Boolean)
            .join(' ')}
          aria-pressed={activeAllTime && !breathing}
          onClick={() => onActiveAllTime?.(!(activeAllTime && !breathing))}
          title="Stretch the gold back to the oldest run on record — runs are Python-only and kept for a file's last 50 five-minute buckets, so this can be hours rather than months"
        >
          All time
        </button>
      </div>
    </div>
  );
}
