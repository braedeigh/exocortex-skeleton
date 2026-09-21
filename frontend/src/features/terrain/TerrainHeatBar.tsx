import { useId } from 'react';
import {
  formatAge,
  GOLD_BREATH_SECONDS,
  HEAT_DAYS_MAX,
  HEAT_DAYS_MIN,
  heatTrackStops,
  RUN_WINDOW_SECONDS,
} from './terrainGraph';
import { GOLD_RAMP_LIGHT, HEAT_RAMP_LIGHT, heatColor } from './terrainCanvas';
import { POS_STEPS, posFromValue, valueFromPos } from './TerrainDials';
import {
  ACTIVE_ANCHOR_SECONDS,
  ACTIVE_TICK_SECONDS,
  activePct,
  posFromSeconds,
  secondsFromPos,
} from './activeScale';
import styles from './TerrainHeatBar.module.css';

/**
 * TerrainHeatBar — the map's heat lens, as one slider instead of three chips.
 *
 * It sets the WINDOW: how far back a file stays lit. Short, and only the last
 * day is lit; long, and the map remembers back a year. The thumb is the EDGE
 * of the colour — fully lit today, half lit a third of the way along, gone at
 * the dot (terrainGraph.ts windowToHalfLife has the arithmetic). This used to
 * be three buttons (Day / Week / Month), which were always just three presets
 * on the same number.
 *
 * Some things worth knowing about the shape of it:
 *
 * 1. **The track is logarithmic**, like the Files dial next door and for the
 *    same reason: one day to one year is a 365x span, so a linear track would
 *    bunch the most-used settings into its left sliver and spend most of its
 *    travel on the difference between ten months and twelve. On a log track
 *    the day/week/month/year presets land at roughly even strides.
 * 2. **The map's own colour ramp fills the track up to the thumb**, so the
 *    control IS the legend: read as an age axis, the colour under any point
 *    is what a file that old wears on the map right now, and past the thumb
 *    it's ash. Drag right and the fill lengthens — a longer memory, shown
 *    rather than labelled. The sampling maths is heatTrackStops in
 *    terrainGraph.ts; the colours come from the same heatColor the canvas
 *    paints nodes with.
 * 3. **A tick per day, etched over the ramp.** They crowd toward the long end,
 *    which is honest — that crowding IS the log compression, drawn rather than
 *    hidden. The three preset days stand taller so the anchors stay findable.
 * 4. **The presets are buttons that move the slider**, not a separate mode.
 *    There's one value here and one control over it; the buttons are shortcuts
 *    to points on the same track, and they light up when the slider is on them.
 *    They sit ABOVE the track: this block is the top of the bottom-left stack
 *    now, so the buttons are the first thing the eye lands on coming down.
 * 5. **Dynamic is the one that isn't a point** — it hands the window to the
 *    same breath the Observatory backdrop runs on (breathHalfLife), swelling
 *    from a day out to a month and settling back once every ten seconds.
 *    Gold takes the next breath, on its own band and its own range (note 6). It
 *    stays inside the "buttons move the slider" rule rather than breaking it:
 *    the page keeps feeding this component the breath's live value, so the
 *    thumb glides the track and the ramp brightens and dims under it. The mode
 *    is visible as motion on the control itself, not as a separate state the
 *    slider has to be switched out of. Touching the slider or any fixed preset
 *    takes the value back — the page turns breathing off on any onDays.
 * 6. **Two bands, two axes.** Ember above on the day-to-year track; gold
 *    below on ITS OWN track, five minutes to one day, with an hour ruler.
 *    The thumb sets ember's window and rides the upper band. A gold ring
 *    marks gold's edge on the lower band: at rest and on every fixed preset
 *    it sits at the far right (one day — "did this code run today",
 *    terrainGraph.ts RUN_WINDOW_SECONDS); under Dynamic the two take turns
 *    (alternatingBreath), each resting at its smallest: for one cycle the
 *    thumb reaches right to a month and returns while the ring waits at the
 *    far left (five minutes); the next, the ring swells right to the day and
 *    returns while the thumb rests at a day. The ring is a marker, not a
 *    control: gold's window isn't hers to set, so there's nothing to grab.
 *    Read either band as an age axis and the colour under a point is what a
 *    file that old wears right now.
 *    Prompts: "i want it to show like what has run in the past minute up to
 *    the past day" → "have one breath be the time of editing, then the other
 *    breath be the time of the last activated, and then have them alternate"
 *    → "when the red is at its smallest, the yellow is at its largest.
 *    Currently yellow is off kilter and stays yellow in half of the cycle
 *    while the red is glowing up".
 * 7. **Types is a switch, not a preset.** It sits at the end of the same row
 *    because it answers the same question — how the map is lit — but it
 *    doesn't move the slider: on, every file dot wears its file type's GitHub
 *    colour and the heat HUES are overridden (terrainCanvas.ts). The slider
 *    still works underneath it, and in two ways: heat sets dot SIZE, and it
 *    sets how much of the type colour is left (terrainCanvas.ts
 *    staleTypeColor) — a fresh file wears its colour whole, a stale one sinks
 *    into the sky and is gone by the thumb, and the lines into it recede with
 *    it as far as half (staleTypeAlpha), so the limb goes quiet together but
 *    the tree's shape survives. Folders take it too: a hollow folder's
 *    outline is split between the file types beneath it, each taking the
 *    share its count earns (folderTypes.ts), and the folder fades out with
 *    its contents — a branch with nothing live left in it goes entirely,
 *    label and lines included. So under Types the thumb is a staleness dial:
 *    drag it right and older files come back. A gap sets it
 *    apart from the presets so it doesn't read as a fifth window. The value
 *    itself lives in typeColorPref.ts and stays on across reloads.
 *    Prompts: "a toggle to color the dots by file type like with the github
 *    scheme … that overrides the other colors when i toggle it on" → "i want
 *    to hide stale files … the dots turn black or disappear when i am on the
 *    'types' display" → "the lines that go to the dots faded too … to show
 *    they're 'there' but not be so prominent as the others".
 * 8. **One switch on this bar, and it only ever ADDS light.** The pill
 *    reading "Active" is a button: lit, every file that RAN inside the Active
 *    slider's window wears a gold halo on the map; hollow, nothing is marked.
 *    The switch sits where you already look to see which bar you're on.
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
 * 9. **The two sliders have two axes, on purpose.** Heat runs days out to a
 *    year; Active runs five minutes out to a week (activeScale.ts). They are
 *    not comparable by eye and shouldn't be — they answer different questions
 *    in different units, and Active's is the one measured in minutes and
 *    hours. This overturns an earlier decision to put both on one ruler so
 *    the two edges could be compared; that comparison turned out to be worth
 *    less than being able to aim the Active thumb at "the last half hour".
 *
 *    One plain log track does the condensing she asked for by itself: minutes
 *    get real travel at the near end, a day lands about three-quarters along,
 *    and the whole day-to-week stretch folds into the last quarter. The floor
 *    is five minutes because that's the run sensor's bucket size
 *    (runtime_sensor.py BUCKET_SEC) — finer than that, the signal can't
 *    honestly speak.
 *    Prompts: "i want for the active to be a 24 hour toggle with minutes and
 *    hours marks instead of what it is now that matches heat" → "it should
 *    toggle 24 hours to one week or something on a condensed scale past 24
 *    hours and up to minutes on the left".
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

/** The gold band's own axis: five minutes to a day, in days, log like the
 * ember track. */
const GOLD_MIN_DAYS = GOLD_BREATH_SECONDS.min / 86400;
const GOLD_MAX_DAYS = GOLD_BREATH_SECONDS.max / 86400;
function goldPct(days: number): number {
  return (posFromValue(days, GOLD_MIN_DAYS, GOLD_MAX_DAYS) / POS_STEPS) * 100;
}

/** The gold ruler: a tick per hour to the day's end, plus the quarter-hours
 * inside the first hour so the near end isn't a bare stretch. */
const GOLD_TICK_DAYS = [
  ...[15, 30, 45].map((m) => m / 1440),
  ...Array.from({ length: 24 }, (_, i) => (i + 1) / 24),
];
const GOLD_ANCHOR_DAYS = new Set([1 / 24, 1]);

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
  /** The gold ramp, painted as the lower band (see note 6). Same provenance
   * as `ramp`: heatRamps(ink).gold from the page. */
  goldRamp?: readonly string[];
  /** Gold's live window in seconds — the fixed day at rest, the gold breath
   * under Dynamic. Places the ring and paints the lower band. */
  goldSeconds?: number;
  /** True while the half-life is riding the breath. */
  breathing?: boolean;
  onBreathe?: () => void;
  /** True while file dots are coloured by file type instead of heat (note 7). */
  typeColors?: boolean;
  onTypeColors?: (on: boolean) => void;
  /** The Active bar: whether the halo is on, and its window in SECONDS
   * (notes 8 and 9). Seconds rather than days because this axis runs down to
   * five minutes, where a whole number of days has no resolution left. */
  activeGlow?: boolean;
  onActiveGlow?: (on: boolean) => void;
  activeSeconds?: number;
  onActiveSeconds?: (seconds: number) => void;
}

const DAY_SECONDS = 24 * 3600;

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
  goldSeconds = RUN_WINDOW_SECONDS,
  breathing = false,
  onBreathe,
  typeColors = false,
  onTypeColors,
  activeGlow = false,
  onActiveGlow,
  activeSeconds = 3600,
  onActiveSeconds,
}: TerrainHeatBarProps) {
  const id = useId();
  const activeId = useId();
  // The fill along the track, hot (today) on the left and running out at the
  // thumb — the same colours, from the same lookup, as the nodes.
  const gradient = trackGradient(days, ramp);
  // Gold's band on its own five-minutes-to-a-day axis: the fill runs out at
  // the ring, which sits at the day's end at rest and glides under Dynamic.
  const goldDays = goldSeconds / DAY_SECONDS;
  const goldGradient = trackGradient(goldDays, goldRamp, GOLD_MIN_DAYS, GOLD_MAX_DAYS);
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
          <span
            className={`${styles.ramp} ${styles.rampEmber}`}
            style={{ background: gradient }}
            aria-hidden="true"
          />
          <span
            className={`${styles.ramp} ${styles.rampGold}`}
            style={{ background: goldGradient }}
            aria-hidden="true"
          />
          <span
            className={styles.goldRing}
            style={{ left: `${goldPct(goldDays)}%`, borderColor: goldHot }}
            aria-hidden="true"
          />
          <span className={`${styles.ticks} ${styles.ticksGold}`} aria-hidden="true">
            {GOLD_TICK_DAYS.map((d) => (
              <span
                key={d}
                className={[styles.tick, GOLD_ANCHOR_DAYS.has(d) ? styles.tickAnchor : '']
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: `${goldPct(d)}%` }}
              />
            ))}
          </span>
          <span className={`${styles.ticks} ${styles.ticksEmber}`} aria-hidden="true">
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
            className={`${styles.range} ${styles.rangeSplit}`}
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
            next to it rather than to a column off in the corner. This one
            names both of Heat's windows, a dot in each fire's hot colour
            before its number, so "7d · 1d" can't be read the wrong way round. */}
        <span className={styles.readout}>
          <span className={styles.readoutDot} style={{ background: ramp[ramp.length - 1] }} />
          {Math.round(days)}d
          <span className={styles.readoutDot} style={{ background: goldHot }} />
          {formatAge(goldSeconds)}
        </span>
      </div>
      {/* The Active bar (notes 8 and 9): its own question on its own ruler —
          five minutes to a week, in minutes and hours, not Heat's days. Lit,
          the files that ran inside this window wear a gold halo; nothing is
          ever hidden by it. */}
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
        <div className={`${styles.track} ${styles.plainTrack}`}>
          <span className={`${styles.ticks} ${styles.ticksPlain}`} aria-hidden="true">
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
            aria-label="How recently a file must have run to be marked"
            aria-valuetext={formatAge(activeSeconds)}
          />
        </div>
        {/* The window this bar is set to, readable whether or not the switch
            is lit — a setting you can't see is one you have to turn on to
            find. The marker is a hollow gold ring because that is literally
            the mark it puts on the map (terrainCanvas.ts drawRunHalo). */}
        <span className={styles.readout}>
          <span className={styles.readoutRing} style={{ borderColor: goldHot }} />
          {formatAge(activeSeconds)}
        </span>
      </div>
    </div>
  );
}
