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

/** Integrate one repo's days into a cumulative curve. `delta` picks what each
 * day contributes: d => d.born - d.died gives "files alive", d => d.added -
 * d.removed gives "lines of code". */
export function cumulative(days: GrowthDay[], delta: (d: GrowthDay) => number): SeriesPoint[] {
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
}

export function monthlyRollup(days: GrowthDay[]): MonthRow[] {
  const by = new Map<string, MonthRow>();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    const row = by.get(key) ?? { month: key, commits: 0, files: 0, lines: 0 };
    row.commits += d.commits;
    row.files += d.born - d.died;
    row.lines += d.added - d.removed;
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
