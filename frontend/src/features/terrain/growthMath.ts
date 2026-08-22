/**
 * growthMath.ts — pure maths for the Growth room (TerrainGrowthView.tsx):
 * turning the per-day deltas GET /api/observatory/terrain/growth serves into
 * cumulative curves, windowed slices, axis ticks and compact figures. No DOM,
 * no fetch — everything here is testable arithmetic, same split as
 * usageRanking.ts next door.
 *
 * The server sends DELTAS (what happened each day) rather than running totals,
 * because a date window changes what "so far" means: a curve entering a window
 * must enter at its true height (everything before the window still exists),
 * which is the carry-forward rule in windowPoints below.
 *
 * The velocity bars (files BORN per day/week/month) are a second read of the
 * same deltas, not integrated: velocityBars bins `born` by whichever unit is
 * asked for. That unit used to be picked automatically from the time window
 * (velocityBinUnit, still here and still tested, in case anything wants a
 * "sensible default for this window" again) — her call was to make it a
 * direct choice instead ("I want the velocity bars to be by day not month or
 * like interchangeable"), so TerrainGrowthView now reads it from its own
 * Day/Week/Month control (default Day) rather than deriving it from `days`.
 * A daily bar over "All" can run thin — that's hers to pick now, not a size
 * the maths guesses for her.
 *
 * The facet helpers (facetVelocityBins, splitVelocityBars, frontChipLabel)
 * are for the growth room's "highlight a place or front" chip row: GET
 * .../growth/facet (routes/terrain.py) returns one lit subject's own
 * born/died days, and these turn that into the same shapes the existing
 * cumulative()/VelocityBar machinery already draws — a lit curve is just
 * another cumulative() series, a lit velocity bar is an existing bar
 * re-keyed into {lit, rest} instead of {skeleton, vault}. cumulative() itself
 * is generic over any `{date}`-shaped day rather than GrowthDay specifically,
 * so a facet's {date, born, died} rows integrate through the identical
 * function repo days do.
 *
 * Prompt that produced this file: "I want to build more UI like terrain and
 * make visualizations of my entire codebase/file system as it grows."
 */

export interface GrowthDay {
  date: string; // 'YYYY-MM-DD'
  commits: number;
  added: number;
  removed: number;
  born: number;
  died: number;
}

export interface GrowthRepo {
  id: string;
  name: string;
  days: GrowthDay[];
}

export interface GrowthData {
  generated_at: string;
  repos: GrowthRepo[];
}

/** GET /api/observatory/terrain/growth/facets — the chip row's contents. */
export interface FacetPlace {
  id: string;
  label: string;
  files: number;
}

export interface FacetFront {
  tag: string;
  files: number;
}

export interface GrowthFacets {
  places: FacetPlace[];
  fronts: FacetFront[];
}

/** One day of a lit facet's own history — GET .../growth/facet's shape,
 * deliberately a subset of GrowthDay's fields (no commits/added/removed: a
 * facet only ever answers "how many files", never "how many lines"). */
export interface FacetDay {
  date: string;
  born: number;
  died: number;
}

export interface FacetSeries {
  ns: 'place' | 'front';
  tag: string;
  days: FacetDay[];
}

/** A lit chip's identity — which axis, which value. */
export interface LitFacet {
  ns: 'place' | 'front';
  tag: string;
}

/** 'living-space' -> 'Living space' — the front chips have no server-side
 * display name (unlike places, which carry one), so this is the one
 * formatting rule: hyphens to spaces, sentence case. Good enough for the
 * short front-tag vocabulary (docs/tags-architecture.md); a real display
 * name would need fetching fronts.json, which would drag react-query into a
 * room that deliberately doesn't use it (see TerrainGrowthView's docblock). */
export function frontChipLabel(tag: string): string {
  const words = tag.split('-').filter(Boolean);
  if (words.length === 0) return tag;
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

/** A cumulative curve point: unix seconds × running total. */
export interface SeriesPoint {
  t: number;
  v: number;
}

/** A day's date string as unix seconds (UTC midnight — the axis only needs
 * days to land in order and evenly, never a wall-clock instant). */
export function dayEpoch(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

/** Integrate a repo's (or a lit facet's) days into a cumulative curve. `delta`
 * picks what each day contributes: d => d.born - d.died gives "files alive",
 * d => d.added - d.removed gives "lines of code". Generic over any
 * `{date}`-shaped row rather than GrowthDay specifically, so a facet's
 * {date, born, died} (no commits/added/removed) integrates through the same
 * function a repo's full daily row does — one cumulative curve implementation
 * for every line this room ever draws. */
export function cumulative<T extends { date: string }>(
  days: T[],
  delta: (d: T) => number,
): SeriesPoint[] {
  let running = 0;
  return days.map((d) => {
    running += delta(d);
    return { t: dayEpoch(d.date), v: running };
  });
}

/**
 * Slice a cumulative curve to a window, carrying the pre-window total in as a
 * synthetic first point AT the window edge. Without it a curve windowed to 30
 * days would start from zero and lie — the codebase didn't restart last month.
 * `from` = null means the whole curve.
 */
export function windowPoints(points: SeriesPoint[], from: number | null): SeriesPoint[] {
  if (from === null) return points;
  const inWindow = points.filter((p) => p.t >= from);
  const before = points.filter((p) => p.t < from);
  const carried = before.length ? [{ t: from, v: before[before.length - 1].v }] : [];
  return [...carried, ...inWindow];
}

/** Sum a field over a repo's days, optionally only from a cutoff. The stat
 * tiles use this so they describe the same window the charts do. */
export function sumSince(
  days: GrowthDay[],
  from: number | null,
  pick: (d: GrowthDay) => number,
): number {
  return days.reduce(
    (sum, d) => (from === null || dayEpoch(d.date) >= from ? sum + pick(d) : sum),
    0,
  );
}

/** How wide a velocity bar's bin is, picked per window so a bar never gets
 * too thin to read: 90 days as daily bars stays comfortable; the same daily
 * bin over a year would be 365 slivers, so 1 year steps up to ISO weeks and
 * "All" (which can span years) steps up again to calendar months. */
export type BinUnit = 'day' | 'week' | 'month';

export function velocityBinUnit(days: number | null): BinUnit {
  if (days === 90) return 'day';
  if (days === 365) return 'week';
  return 'month';
}

/** A bin's start (UTC seconds) for one date, by unit. Weeks are ISO —
 * Monday start — so a Sunday and the Monday before it land in the same bin,
 * and a day on a week or month boundary lands in exactly one bin, never
 * split across two or double-counted. */
function binStart(date: string, unit: BinUnit): number {
  if (unit === 'day') return dayEpoch(date);
  const d = new Date(dayEpoch(date) * 1000);
  if (unit === 'month') {
    d.setUTCDate(1);
    return d.getTime() / 1000;
  }
  const dow = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1)); // walk back to Monday
  return d.getTime() / 1000;
}

/** A bin's short label, by unit — day/week bins label their start date
 * ('Jun 14'); month bins label the month, year on January, mirroring
 * monthTicks below. */
function binLabel(t: number, unit: BinUnit): string {
  const d = new Date(t * 1000);
  if (unit === 'month') {
    const m = d.getUTCMonth();
    return m === 0 ? `${MONTHS[m]} ${d.getUTCFullYear()}` : MONTHS[m];
  }
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** One binned bar: its start, a label, and each repo's `born` count for that
 * bin keyed by repo id — generic over however many repos are in play, so a
 * future facet (e.g. by vault place/tag) is more entries in `values`, not a
 * different shape. */
export interface VelocityBar {
  t: number;
  label: string;
  values: Record<string, number>;
}

/** Bin every repo's `born` deltas together by time. Reads over ALL history,
 * same as cumulative — the window only slices afterwards (windowBars), so
 * flipping window presets never re-bins. */
export function velocityBars(
  repos: { id: string; days: GrowthDay[] }[],
  unit: BinUnit,
): VelocityBar[] {
  const by = new Map<number, VelocityBar>();
  for (const repo of repos) {
    for (const d of repo.days) {
      const t = binStart(d.date, unit);
      const bar = by.get(t) ?? { t, label: binLabel(t, unit), values: {} };
      bar.values[repo.id] = (bar.values[repo.id] ?? 0) + d.born;
      by.set(t, bar);
    }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/** Slice binned bars to a window. Unlike windowPoints (a cumulative curve
 * that must carry its pre-window height in), a bar's value is just its own
 * bin's count — nothing to carry forward — so this is a plain boundary
 * filter. The bin unit is chosen per window (velocityBinUnit) so at most one
 * bin's worth ever falls just outside the edge. */
export function windowBars(bars: VelocityBar[], from: number | null): VelocityBar[] {
  if (from === null) return bars;
  return bars.filter((b) => b.t >= from);
}

/** Bin a lit facet's own `born` counts by the SAME binStart the repo bars
 * above use, so the bin keys line up exactly (same `t`) with whatever
 * `velocityBars` already produced — that's what lets splitVelocityBars below
 * just look a bin up by timestamp rather than re-deriving one. */
export function facetVelocityBins(days: FacetDay[], unit: BinUnit): Map<number, number> {
  const bins = new Map<number, number>();
  for (const d of days) {
    const t = binStart(d.date, unit);
    bins.set(t, (bins.get(t) ?? 0) + d.born);
  }
  return bins;
}

/** Re-key each existing velocity bar's total into {lit, rest} using a lit
 * facet's own per-bin born counts (facetVelocityBins) — same bars, same
 * order, just a different `values` shape, so VelocityChart's generic
 * segment-stacking draws the emphasis with no separate render path. A bin
 * the facet never touched still appears, lit at 0. Clamped so a facet count
 * can never read as more than the bar's own total (the facet is always a
 * subset of it; the clamp is a defensive floor, not an expected case). */
export function splitVelocityBars(bars: VelocityBar[], litBins: Map<number, number>): VelocityBar[] {
  return bars.map((b) => {
    const total = Object.values(b.values).reduce((sum, v) => sum + v, 0);
    const lit = Math.min(litBins.get(b.t) ?? 0, total);
    return { t: b.t, label: b.label, values: { lit, rest: total - lit } };
  });
}

/**
 * Clean axis ticks from 0 to at least `max`: steps of 1/2/5 × 10^k, at most
 * `count` lines. Charts always include 0 — growth curves are read against the
 * ground, and a clipped baseline is the classic way a trend chart lies.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  // Threshold rounding, not round-up: 2.25× a power lands on the 2-step (a
  // ruler of 2s), where always-rounding-up would jump to 5 and starve the
  // axis down to two lines.
  const r = rough / pow;
  const step = pow * (r <= 1.5 ? 1 : r <= 3 ? 2 : r <= 7 ? 5 : 10);
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return ticks;
}

/** 1,284 → '1,284' · 12_900 → '12.9K' · 1_240_000 → '1.24M'. Signed when
 * negative; the stat tiles show net change, which can genuinely shrink. */
export function compact(n: number): string {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}${trim(abs / 1_000)}K`;
  return `${sign}${abs.toLocaleString('en-US')}`;
}

function trim(x: number): string {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(x >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** X-axis ticks at each month boundary inside [from, to] (unix seconds).
 * January carries its year — the one moment the axis needs one. */
export function monthTicks(from: number, to: number): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  const d = new Date(from * 1000);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1); // first boundary AFTER the window opens
  while (d.getTime() / 1000 <= to) {
    const m = d.getUTCMonth();
    out.push({
      t: d.getTime() / 1000,
      label: m === 0 ? `${MONTHS[m]} ${d.getUTCFullYear()}` : MONTHS[m],
    });
    d.setUTCMonth(m + 1);
  }
  return out;
}

/** 'Jun 14' — the tooltip's date line. */
export function shortDate(t: number): string {
  const d = new Date(t * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** 'YYYY-MM' → 'Jun 2026' — the monthly table's row label. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

/** Fold a repo's days into per-month rows for the table view — the no-hover
 * home of every number the charts show. Newest month first. */
export interface MonthRow {
  month: string; // 'YYYY-MM'
  commits: number;
  files: number; // net born - died
  lines: number; // net added - removed
  born: number; // files created, gross — the velocity panel's own number
}

export function monthlyRollup(days: GrowthDay[]): MonthRow[] {
  const by = new Map<string, MonthRow>();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    const row = by.get(key) ?? { month: key, commits: 0, files: 0, lines: 0, born: 0 };
    row.commits += d.commits;
    row.files += d.born - d.died;
    row.lines += d.added - d.removed;
    row.born += d.born;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** Nearest curve time to `t` across every series — what the crosshair snaps
 * to, so the pointer aims at a day rather than at a 2px line. */
export function nearestTime(seriesTimes: number[][], t: number): number | null {
  let best: number | null = null;
  for (const times of seriesTimes) {
    for (const st of times) {
      if (best === null || Math.abs(st - t) < Math.abs(best - t)) best = st;
    }
  }
  return best;
}

/** The curve's value at time `t`: the last point at or before it (a cumulative
 * total holds steady between events), or null before the curve begins. */
export function valueAt(points: SeriesPoint[], t: number): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}
