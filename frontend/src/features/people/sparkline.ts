// sparkline.ts — pure point math for the per-person mention-activity
// sparkline, ported from people.js's monthly-bin SVG builder: one bar per
// calendar month from the first mention through "now", baseline-anchored
// with rounded tops, and a continuous 3px stub for zero-mention months.

/** Geometry constants (SVG user units) — same numbers as the old builder. */
export const SPARK_BAR_W = 8;
export const SPARK_GAP = 2;
export const SPARK_H = 36;
export const SPARK_MAX_BAR_H = 30;
export const SPARK_STUB_H = 3;

export interface SparkBar {
  path: string;
  /** true = mention bar (accent fill); false = zero-month stub. */
  filled: boolean;
  /** Hover tooltip, e.g. "May 2026 — 2 days". */
  title: string;
}

export interface SparkSpec {
  width: number; // viewBox width
  height: number; // viewBox height
  bars: SparkBar[];
}

export function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/** '2026-05' → "May 2026". */
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** Every 'YYYY-MM' from the first date's month through now's month,
 * inclusive. Empty when there are no dates (or the first date is in a
 * future month). */
export function buildMonthRange(dates: readonly string[], now: Date): string[] {
  if (!dates.length) return [];
  let [y, m] = monthKey(dates[0]).split('-').map(Number);
  const ny = now.getFullYear();
  const nm = now.getMonth() + 1;
  const months: string[] = [];
  while (y < ny || (y === ny && m <= nm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/** A bar with only the top corners rounded (a plain rect's radius would also
 * round the bottom, which reads oddly sitting flush on the baseline). */
export function roundedTopBarPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h);
  const bottom = y + h;
  return (
    `M${x},${bottom} L${x},${y + r} Q${x},${y} ${x + r},${y} ` +
    `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${bottom} Z`
  );
}

/** All the math for one person's sparkline; null when there's nothing to
 * draw. Bars are scaled to the busiest month (min 4px so a 1-day month is
 * still visible); zero months get the stub. */
export function buildSparkline(dates: readonly string[], now: Date): SparkSpec | null {
  const months = buildMonthRange(dates, now);
  if (!months.length) return null;

  const counts = new Map<string, number>();
  dates.forEach((d) => {
    const k = monthKey(d);
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const maxCount = Math.max(1, ...months.map((k) => counts.get(k) || 0));

  const bars = months.map((k, i) => {
    const c = counts.get(k) || 0;
    const h = c ? Math.max(4, Math.round(SPARK_MAX_BAR_H * (c / maxCount))) : SPARK_STUB_H;
    const x = i * (SPARK_BAR_W + SPARK_GAP);
    const y = SPARK_H - h;
    return {
      path: roundedTopBarPath(x, y, SPARK_BAR_W, h, 2),
      filled: c > 0,
      title: `${monthKeyLabel(k)} — ${c} day${c === 1 ? '' : 's'}`,
    };
  });

  return {
    width: months.length * SPARK_BAR_W + (months.length - 1) * SPARK_GAP,
    height: SPARK_H,
    bars,
  };
}
