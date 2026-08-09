/**
 * pondMath.ts — where every card sits in the pond, and where a thread's line runs.
 *
 * The pond is the journal drawn as a place rather than a feed: time runs left
 * to right, one column per day, and inside a column each card sits at the hour
 * it was written. So the shape of a week is visible at a glance — the 2am
 * cards sit low, the morning ones high, a quiet day is a nearly empty column.
 * Light up one thread and its cards join into a line that dips and climbs
 * across the days it touches. That bouncing IS the thread's shape: something
 * that surfaces on ten days across a month draws a long, broken, wandering
 * line, and nothing else in the system shows that.
 *
 * This module is only the arithmetic. It takes the cards the API returned and
 * answers two questions — where does each card go, and what path connects one
 * thread's cards — with no React, no SVG and no fetching, so both can be tested
 * directly. PondView.tsx draws what comes back; routes/pond.py supplies the
 * cards.
 *
 * The one judgement call in here is COLLISION. Cards are placed by clock time,
 * which is honest and is what makes the picture worth looking at — but she
 * writes in bursts, and six cards in one minute would land on top of each
 * other and read as one. So after placing, a single downward sweep pushes any
 * card that would overlap its predecessor down to a minimum gap. That keeps
 * order and readability truthful at the cost of exact vertical position in a
 * burst, which is the right trade: nobody reads a y-coordinate off this, they
 * read morning-vs-night and dense-vs-sparse.
 *
 * Prompt that produced it: "the base files laid out by day and time with
 * threads stored inside of them connected by lines, and you can scroll to the
 * left or right over time and the threads bounce around in the entries."
 */

export interface PondCard {
  id: string;
  day: string;
  /** "HH:MM" (sometimes with seconds); null when the pool never recorded one. */
  ts: string | null;
  /** Who spoke — 'B' for her, 'K' for the Keeper. */
  who: string;
  kind: string | null;
  tags: string[];
  preview: string;
}

export interface PlacedCard {
  card: PondCard;
  x: number;
  y: number;
  /** Minutes past midnight, or null if the card had no usable time. */
  minutes: number | null;
}

export interface DayColumn {
  day: string;
  /** Centre of the column. */
  x: number;
  cards: PlacedCard[];
}

export interface PondLayout {
  columns: DayColumn[];
  width: number;
  height: number;
}

export interface PondLayoutOptions {
  /** Horizontal room per day. */
  colWidth: number;
  /** Where midnight sits. */
  top: number;
  /** How tall a full 24 hours is drawn. */
  dayHeight: number;
  /** Closest two cards may sit vertically before the sweep pushes them apart. */
  minGap: number;
}

export const DEFAULT_LAYOUT: PondLayoutOptions = {
  colWidth: 34,
  top: 28,
  dayHeight: 760,
  minGap: 11,
};

const MINUTES_PER_DAY = 1440;

/**
 * "09:00" / "09:00:30" → minutes past midnight. Anything that isn't a real
 * clock time comes back null rather than 0 — a card with no time is a
 * different thing from a card written at midnight, and collapsing them would
 * put a silent pile at the top of the column.
 */
export function parseMinutes(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(ts.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** Distinct days present, ascending. */
export function pondDays(cards: readonly PondCard[]): string[] {
  return [...new Set(cards.map((c) => c.day))].sort();
}

/**
 * Place every card. Days become columns left to right; within a column cards
 * are ordered by time (untimed ones last, then by id so the order is stable
 * between renders) and pushed apart just enough to stay legible.
 */
export function layoutPond(
  cards: readonly PondCard[],
  options: Partial<PondLayoutOptions> = {},
): PondLayout {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  const days = pondDays(cards);
  const byDay = new Map<string, PondCard[]>();
  for (const card of cards) {
    const list = byDay.get(card.day);
    if (list) list.push(card);
    else byDay.set(card.day, [card]);
  }

  let lowest = opt.top + opt.dayHeight;
  const columns: DayColumn[] = days.map((day, index) => {
    const x = index * opt.colWidth + opt.colWidth / 2;
    const ordered = [...(byDay.get(day) ?? [])].sort((a, b) => {
      const am = parseMinutes(a.ts);
      const bm = parseMinutes(b.ts);
      // Untimed cards sink to the bottom of the column rather than floating to
      // midnight — they're "sometime that day", not "00:00 that day".
      if (am === null && bm === null) return a.id.localeCompare(b.id);
      if (am === null) return 1;
      if (bm === null) return -1;
      return am - bm || a.id.localeCompare(b.id);
    });

    let prevY = -Infinity;
    const placed = ordered.map((card) => {
      const minutes = parseMinutes(card.ts);
      const clockY =
        minutes === null
          ? opt.top + opt.dayHeight
          : opt.top + (minutes / MINUTES_PER_DAY) * opt.dayHeight;
      // One downward sweep. Because `ordered` is already in vertical order,
      // pushing each card below the last is enough — no iteration needed.
      const y = Math.max(clockY, prevY + opt.minGap);
      prevY = y;
      if (y > lowest) lowest = y;
      return { card, x, y, minutes };
    });

    return { day, x, cards: placed };
  });

  return {
    columns,
    width: Math.max(days.length * opt.colWidth, opt.colWidth),
    height: lowest + opt.minGap * 2,
  };
}

/**
 * The polyline for one lit thread: its cards in time order, as points.
 *
 * Deliberately one continuous path across every day the thread touches, gaps
 * included — the long flat stretch between two appearances is the silence, and
 * it's as much a part of the thread's shape as the busy stretches. Breaking
 * the line at gaps would draw a set of episodes; joining it draws a life.
 */
export function threadPoints(
  layout: PondLayout,
  tag: string | null,
): PlacedCard[] {
  if (!tag) return [];
  const hits: PlacedCard[] = [];
  for (const column of layout.columns) {
    for (const placed of column.cards) {
      if (placed.card.tags.includes(tag)) hits.push(placed);
    }
  }
  return hits;
}

/** An SVG `points` string for a thread's polyline. */
export function polylinePoints(points: readonly PlacedCard[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/**
 * Hour gridlines worth drawing, as {minutes, label} — every 6 hours. Enough to
 * read morning from night without ruling the whole surface into a spreadsheet.
 */
export function hourLines(
  options: Partial<PondLayoutOptions> = {},
): { y: number; label: string }[] {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  return [0, 6, 12, 18].map((hour) => ({
    y: opt.top + ((hour * 60) / MINUTES_PER_DAY) * opt.dayHeight,
    label: hour === 0 ? '12a' : hour === 12 ? '12p' : hour < 12 ? `${hour}a` : `${hour - 12}p`,
  }));
}

/** "2026-08-09" → "Aug 9". Month shown only when it changes down the row. */
export function dayLabel(day: string, previous?: string): string {
  const [, month, date] = day.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const name = months[Number(month) - 1] ?? month;
  const sameMonth = previous && previous.slice(0, 7) === day.slice(0, 7);
  return sameMonth ? String(Number(date)) : `${name} ${Number(date)}`;
}
