import { describe, expect, it } from 'vitest';
import {
  CHAR_CAP,
  JUMP_DAYS,
  PANE_ZOOMS,
  PANE_ZOOM_DEFAULT,
  dayNumber,
  layoutPane,
  markHeat,
  markHeight,
  paneCaption,
  type PaneOptions,
  type SizedDay,
} from './pondPane';

const z = PANE_ZOOMS[1];

const day = (d: string, chars: number[]): SizedDay => ({
  day: d,
  cards: chars.length,
  owner: chars.length,
  chars,
});

const opts = (over: Partial<PaneOptions> = {}): PaneOptions => ({
  width: 200,
  height: 100,
  zoom: z,
  scrollX: 0,
  jump: 'week',
  ...over,
});

describe('markHeight', () => {
  it('grows with how much was written', () => {
    expect(markHeight(400, z)).toBeGreaterThan(markHeight(100, z));
  });

  it('floors a card so one that exists is always visible', () => {
    // An empty card is still a moment she wrote something.
    expect(markHeight(0, z)).toBe(z.minCard);
    expect(markHeight(1, z)).toBe(z.minCard);
  });

  it('caps at the same length the real pond stops reading at', () => {
    // The whole point of borrowing fullBelow: the pane and PondView must agree
    // about which cards are "big". A 15,000-char card is not 25x a 600-char one.
    expect(markHeight(CHAR_CAP * 25, z)).toBe(markHeight(CHAR_CAP, z));
  });
});

describe('markHeat', () => {
  it('puts the freshest thing at the hot end and the oldest near black', () => {
    expect(markHeat(0, 28)).toBe(1);
    expect(markHeat(28, 28)).toBeCloseTo(2 ** -4);
  });

  it('never compresses tighter than the floor the caller passes', () => {
    // THE FIX FOR THE ONE WAY A WINDOW-RELATIVE RAMP GOES WRONG. Zoomed into a
    // single day, an ordinary afternoon must not be dressed up as a full
    // black-to-red sunset. Inside a week-long floor, one day reads uniformly hot.
    const acrossOneDay = markHeat(1, JUMP_DAYS.week);
    expect(acrossOneDay).toBeGreaterThan(0.6);
  });
});

describe('layoutPane', () => {
  it('draws nothing rather than throwing on an empty pond or a zero box', () => {
    expect(layoutPane([], opts()).columns).toEqual([]);
    expect(layoutPane([day('2026-07-06', [10])], opts({ width: 0 })).columns).toEqual([]);
  });

  it('gives every card its own rectangle', () => {
    // Not a per-day total — this is the whole ask. Twenty short entries and
    // one long one must be countable as different things.
    const many = layoutPane([day('2026-07-06', Array(20).fill(20))], opts());
    const one = layoutPane([day('2026-07-06', [400])], opts());
    expect(many.columns[0].marks).toHaveLength(20);
    expect(one.columns[0].marks).toHaveLength(1);
  });

  it('fills the column from the bottom, oldest card on the bed', () => {
    const layout = layoutPane([day('2026-07-06', [100, 100, 100])], opts());
    const marks = layout.columns[0].marks;
    // First written sits lowest; each later one stacks above it.
    expect(marks[0].y).toBeGreaterThan(marks[1].y);
    expect(marks[1].y).toBeGreaterThan(marks[2].y);
    // And the first one's foot is on the bed.
    expect(marks[0].y + marks[0].h).toBeCloseTo(100);
  });

  it('leaves a real gap between stacked cards', () => {
    // The gap is what turns a bar into a bar GRAPH — without it a day is one
    // continuous smear that can only report its total.
    const layout = layoutPane([day('2026-07-06', [200, 200])], opts());
    const [lower, upper] = layout.columns[0].marks;
    expect(lower.y - (upper.y + upper.h)).toBeCloseTo(z.gap);
  });

  it('says when a day stacked over the rim instead of squashing it to fit', () => {
    const quiet = layoutPane([day('2026-07-06', [CHAR_CAP, CHAR_CAP])], opts());
    const heavy = layoutPane([day('2026-07-06', Array(200).fill(CHAR_CAP))], opts());
    expect(quiet.columns[0].overflow).toBe(false);
    expect(heavy.columns[0].overflow).toBe(true);
    // The SAME card draws the same height in a crowded column as in a quiet
    // one. If crowding shrank it, the drawing would be rescaling to fit — the
    // one thing an aperture must never do.
    expect(heavy.columns[0].marks[0].h).toBe(quiet.columns[0].marks[0].h);
  });

  it('is an aperture: a wider box shows more time, not bigger marks', () => {
    const days = Array.from({ length: 40 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, [200]),
    );
    const narrow = layoutPane(days, opts({ width: 100 }));
    const wide = layoutPane(days, opts({ width: 300 }));
    expect(wide.columns.length).toBeGreaterThan(narrow.columns.length);
    expect(wide.columns[0].w).toBe(narrow.columns[0].w);
    expect(wide.columns[0].marks[0].h).toBe(narrow.columns[0].marks[0].h);
  });

  it('places days by date, so a fallow stretch stays a gap', () => {
    // Bucketing by index would close the gap and make "jump back a week" move
    // an unpredictable amount of real time.
    const layout = layoutPane(
      [day('2026-07-06', [10]), day('2026-07-16', [10])],
      opts({ width: 400 }),
    );
    const [early, late] = [...layout.columns].sort((a, b) => a.x - b.x);
    expect(late.x - early.x).toBeCloseTo(10 * z.colWidth);
  });

  it('opens pinned to now, with the newest day at the right edge', () => {
    const days = Array.from({ length: 60 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`.slice(0, 10), [100]),
    ).slice(0, 31);
    const layout = layoutPane(days, opts());
    const rightmost = layout.columns.reduce((m, c) => (c.x > m.x ? c : m));
    expect(rightmost.day).toBe('2026-07-31');
    expect(rightmost.x + rightmost.w).toBeLessThanOrEqual(200);
    expect(rightmost.x + rightmost.w).toBeGreaterThan(200 - z.colWidth);
  });

  it('clamps scrolling to the record it actually has', () => {
    const days = Array.from({ length: 40 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, [100]),
    );
    expect(layoutPane(days, opts({ scrollX: -500 })).scrollX).toBe(0);
    const far = layoutPane(days, opts({ scrollX: 99_999 }));
    expect(far.scrollX).toBe(far.maxScroll);
    // Scrolled all the way back, the oldest day is on screen.
    expect(far.from).toBe('2026-07-01');
  });

  it('cannot scroll at all when the whole pond already fits', () => {
    const layout = layoutPane([day('2026-07-06', [10])], opts({ width: 400 }));
    expect(layout.maxScroll).toBe(0);
  });

  it('burns the newest day in view at full heat, wherever she has scrolled', () => {
    // The bright end is the newest day ON SCREEN, not the pane's right edge —
    // which sits a day later, and used to leave the freshest card in the pond
    // permanently a shade short of red.
    const days = Array.from({ length: 40 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, [100]),
    );
    const now = layoutPane(days, opts({ width: 400 }));
    expect(Math.max(...now.columns.map((c) => c.marks[0].t))).toBe(1);
    const back = layoutPane(days, opts({ width: 400, scrollX: 120 }));
    expect(Math.max(...back.columns.map((c) => c.marks[0].t))).toBe(1);
  });

  it('runs the ramp hot at the newest day and dark at the oldest in view', () => {
    const days = Array.from({ length: 28 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, '0')}`, [100]),
    );
    const layout = layoutPane(days, opts({ width: 400, jump: 'week' }));
    const sorted = [...layout.columns].sort((a, b) => a.day.localeCompare(b.day));
    const heats = sorted.map((c) => c.marks[0].t);
    // Monotonic: never brighter as you go back in time.
    expect(heats.every((h, i) => i === 0 || h >= heats[i - 1])).toBe(true);
    expect(heats[heats.length - 1]).toBeGreaterThan(heats[0]);
  });

  it('only builds the columns that are actually on screen', () => {
    const days = Array.from({ length: 300 }, (_, i) =>
      day(dayFrom(i), [100, 100]),
    );
    const layout = layoutPane(days, opts({ width: 200 }));
    // 200px at 7px a day is ~29 days of column, not three hundred.
    expect(layout.columns.length).toBeLessThan(40);
    expect(layout.totalWidth).toBeCloseTo(300 * z.colWidth);
  });
});

describe('the zoom ladder', () => {
  // A day the size of this vault's median: 31 cards, ~5,500 characters between
  // them. The ladder was swept against the real pool to land these; the point
  // of pinning them is that a later tweak to pxPerChar can't quietly go back to
  // the first version, where every day at the tight rungs overflowed and the
  // pane was useless the moment she leaned in.
  const medianDay = () => day('2026-08-21', Array(31).fill(177));
  const box = { width: 440, height: 262 };

  it('has a rung that fits an ordinary day, and opens on it', () => {
    const layout = layoutPane([medianDay()], {
      ...box, zoom: PANE_ZOOMS[PANE_ZOOM_DEFAULT], scrollX: 0, jump: 'week',
    });
    expect(layout.columns[0].overflow).toBe(false);
  });

  it('fits an ordinary day at every rung, so leaning in never breaks it', () => {
    for (const zoom of PANE_ZOOMS) {
      const layout = layoutPane([medianDay()], { ...box, zoom, scrollX: 0, jump: 'week' });
      expect(layout.columns[0].overflow).toBe(false);
    }
  });

  it('grows the marks as it climbs — that is what zooming in is for', () => {
    const heights = PANE_ZOOMS.map((z) => markHeight(300, z));
    const widths = PANE_ZOOMS.map((z) => z.colWidth);
    expect(heights.every((h, i) => i === 0 || h > heights[i - 1])).toBe(true);
    expect(widths.every((w, i) => i === 0 || w > widths[i - 1])).toBe(true);
  });

  it('shows less time as the marks grow — the aperture bargain', () => {
    const days = Array.from({ length: 120 }, (_, i) => dayAt(i, [177]));
    const shown = PANE_ZOOMS.map(
      (zoom) => layoutPane(days, { ...box, zoom, scrollX: 0, jump: 'week' }).columns.length,
    );
    expect(shown.every((n, i) => i === 0 || n < shown[i - 1])).toBe(true);
  });
});

describe('paneCaption', () => {
  it('names the stretch on screen, which is what makes the ramp honest', () => {
    const days = [day('2026-07-06', [10]), day('2026-07-09', [10])];
    expect(paneCaption(layoutPane(days, opts({ width: 400 })))).toBe('Jul 6 – Jul 9');
  });

  it('says one date when only one day is showing', () => {
    expect(paneCaption(layoutPane([day('2026-08-21', [10])], opts()))).toBe('Aug 21');
  });

  it('is empty rather than a dash when nothing is drawn', () => {
    expect(paneCaption(layoutPane([], opts()))).toBe('');
  });
});

/** A day `offset` days after a fixed start — for the tests that need a long
 * contiguous run without hand-writing dates across a month boundary. */
function dayAt(offset: number, chars: number[]): SizedDay {
  return day(dayFrom(offset), chars);
}

/** Sequential days from a fixed start. */
function dayFrom(offset: number): string {
  return new Date((dayNumber('2026-01-01') + offset) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
