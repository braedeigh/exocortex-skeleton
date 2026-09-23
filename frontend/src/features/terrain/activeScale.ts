import { POS_STEPS, posFromValue, valueFromPos } from './TerrainDials';

/**
 * activeScale.ts — the Active bar's own time axis: five minutes to one week.
 *
 * This is the ruler under the map's Active slider — the GOLD bar, the one that
 * sets how recently a file must have RUN to stay lit — and it is deliberately
 * NOT the Heat slider's ruler. Heat asks "how far back does the colour
 * remember an edit", measured in days out to a year. Active asks "when did
 * this file last run", which is a question about minutes and hours — so the
 * two bars carry two axes, and comparing their thumbs by eye is meaningless on
 * purpose.
 *
 * The axis is one plain log track and nothing more clever, because a log track
 * already does the condensing that's wanted here: minutes get real travel on
 * the left, one day lands about three-quarters along, and the whole day-to-week
 * stretch folds into the last quarter. No piecewise scale, no second rate — the
 * compression falls out of the maths the other sliders already use
 * (TerrainDials.ts posFromValue).
 *
 *   5m ──── 15m ──── 1h ──────── 6h ──── 12h ──── 24h ──── 3d ── 7d
 *   0%       14%     33%         56%     65%      74%      89%   100%
 *
 * The floor is five minutes rather than one, and the sensor is why:
 * runtime_sensor.py stamps every run into a FIVE-MINUTE bucket (BUCKET_SEC),
 * so "ran in the last minute" is a thing the data cannot honestly say. Five
 * minutes is this signal's real resolution. The ceiling is a week because the
 * run ring buffer (TOUCH_CAP) only ever drops a file's OLDEST buckets, never
 * its newest — so "last ran three days ago" stays accurate however often the
 * file has run since the sensor started, and the week tail is real travel
 * rather than dead track.
 *
 * Used by TerrainHeatBar.tsx (draws the track, its gold ramp and its ruler)
 * and TerrainPage.tsx (holds the window in seconds and turns it into the gold
 * fire's half-life).
 *
 * Prompts that produced it: "i want for the active to be a 24 hour toggle with
 * minutes and hours marks instead of what it is now that matches heat" → "it
 * should toggle 24 hours to one week or something on a condensed scale past 24
 * hours and up to minutes on the left".
 */

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/** Five minutes: the run sensor's bucket size, and so the finest window this
 * axis can honestly offer. */
export const ACTIVE_MIN_SECONDS = 5 * MINUTE;

/** One week. Past a day the track is compressed, which is the point. */
export const ACTIVE_MAX_SECONDS = 7 * DAY;

/** Where a window sits along the track, 0..100%. Shared by the ruler and the
 * thumb's readout; the input itself works in POS_STEPS. */
export function activePct(seconds: number): number {
  return (posFromSeconds(seconds) / POS_STEPS) * 100;
}

/** The slider's integer position for a window, and back again. Seconds rather
 * than days is not a taste call: valueFromPos rounds to a whole number, so a
 * sub-day window measured in DAYS would collapse to zero everywhere along this
 * track. In seconds the same rounding is invisible. */
export function posFromSeconds(seconds: number): number {
  return posFromValue(seconds, ACTIVE_MIN_SECONDS, ACTIVE_MAX_SECONDS);
}

export function secondsFromPos(pos: number): number {
  return valueFromPos(pos, ACTIVE_MIN_SECONDS, ACTIVE_MAX_SECONDS);
}

/** The ruler, in the unit the eye actually reads at each distance: quarter
 * hours through the first hour so the near end isn't a bare stretch, then a
 * tick per hour to the day, then a tick per day to the week's end. Same
 * instinct as the ember ruler's day-then-month ladder next door — ticks per
 * hour out to seven days would smear into a solid bar. */
export const ACTIVE_TICK_SECONDS: readonly number[] = [
  ...[15, 30, 45].map((m) => m * MINUTE),
  ...Array.from({ length: 24 }, (_, i) => (i + 1) * HOUR),
  ...Array.from({ length: 6 }, (_, i) => (i + 2) * DAY),
];

/** The three the eye should be able to find without counting: an hour, a day,
 * a week. Drawn taller and brighter than the rest. */
export const ACTIVE_ANCHOR_SECONDS: ReadonlySet<number> = new Set([HOUR, DAY, 7 * DAY]);
