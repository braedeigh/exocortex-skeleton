/**
 * pondPane.ts — the pond's WORDS arrangement, shrunk to a thumbnail you can
 * steer.
 *
 * WHAT IT DRAWS. One little rectangle per card, as tall as that card had words
 * in it, stacked up a column per day with a gap between each — so twenty short
 * entries and one long one can never look the same. No text at all: a card here
 * is a bare mark whose SIZE is how much was written and whose COLOUR is how
 * recent it is, on the terrain map's own heat ramp (old = black, through maroon
 * to a just-written red). That's what makes the pane read as part of the map it
 * floats on rather than as a chart parked on top of it.
 *
 * THE COLUMNS FILL FROM THE BOTTOM, like water. The first card of a day sits on
 * the bed and the day stacks upward, so the last thing written is the surface.
 * A quiet day is a puddle, a heavy one is a tall run of countable marks, and the
 * whole row reads as a skyline. It also gives overflow an honest meaning: a day
 * with more in it than the pane is tall goes OVER THE RIM rather than being
 * quietly squashed to fit, and zooming out is how you get it back.
 *
 * THE PANE IS AN APERTURE, NOT A CHART. This is the load-bearing idea and
 * everything else falls out of it. Make the pane bigger and you see MORE TIME
 * at the same mark size; zoom in and the marks grow and you see less. It never
 * rescales its drawing to fit its box — that would be the easy thing to build
 * and it would wreck the point, because then the same day would be a different
 * size depending on how the corner had been dragged, and a rectangle's height
 * would stop meaning "how much was written" and start meaning "how big is my
 * window".
 *
 * DAYS ARE PLACED BY DATE, NOT BY POSITION. pondShape.ts, which draws the
 * resting silhouette, deliberately does the opposite — it buckets by index so a
 * fallow stretch narrows its neighbours instead of opening a gap a postage
 * stamp has no room for. Here a gap is correct and the index would be wrong: if
 * a fallow week collapsed, "jump back a week" would move an unpredictable
 * amount of real time, and time navigation is the entire point of this drawing.
 *
 * Reads `GET /api/pond/shape?sizes=1` (routes/pond.py), which carries per-day
 * card LENGTHS and never any bodies. Used by terrain/PondLandmark.tsx; every
 * function here is pure and tested in pondPane.test.ts.
 *
 * Prompt that produced it: "i want it to be like a floating pane with little
 * squares/rectangles in it like the size of the amount that was written into
 * it... on the words view of the pond, but tiny and represented as almost bar
 * graphs but separated by floating apart separated, and you can scroll back in
 * time or click back in time or display a month or a week" / "basically it
 * would be the words part of pond miniaturized with no text, just red fading to
 * black as it got older" / "you can resize the window and zoom in by scrolling
 * or pinching inside of it for the size of the dots to grow".
 */
import { DEFAULT_LAYOUT } from './pondMath';
import type { ShapeDay } from './pondShape';

/** A day of the pond with its per-card lengths — `/api/pond/shape?sizes=1`. */
export interface SizedDay extends ShapeDay {
  /** How long each card was, in the order it was written. */
  chars: number[];
}

/**
 * Where a card stops growing.
 *
 * Card lengths in this vault run from 2 characters to 15,710 — eight thousand
 * to one, which no single linear scale survives honestly (the same dynamic
 * range that killed the creek). But the real pond already solved it: `excerpt`
 * windows anything past `fullBelow`, so a fifteen-thousand-character day
 * ALREADY draws about the same height there as a six-hundred-character one.
 * Borrowing that exact number rather than picking a new one is what keeps the
 * miniature and the real thing agreeing about which cards are big.
 */
export const CHAR_CAP = DEFAULT_LAYOUT.fullBelow;

/** How the pane is scaled. One rung of the zoom ladder. */
export interface PaneZoom {
  /** Horizontal room for one day. */
  colWidth: number;
  /** Vertical pixels per character written, up to CHAR_CAP. */
  pxPerChar: number;
  /** Space between two stacked cards — what makes them countable objects
   * rather than one continuous bar. This gap IS the ask. */
  gap: number;
  /** The floor. A card that exists has to be visible, however short it was. */
  minCard: number;
}

/**
 * The zoom ladder, coarse to fine.
 *
 * NOT GUESSED — swept against this vault's real 1,720 cards, where a median day
 * is 31 cards / 5,486 capped characters and the heaviest is 76 cards. Against
 * the drawing box a default pane gives (~440x262), the rungs put a median day's
 * column at 94 / 138 / 179 / 222 / 266 px, which is the shape that matters:
 *
 *   · The COARSEST rung fits every day the pond has. Zoomed all the way out
 *     nothing is ever cut off, so there is always one view that holds the whole
 *     record honestly.
 *   · The DEFAULT rung puts 5 days in 47 over the rim — overflow means "that
 *     day was enormous", which is information, rather than being the permanent
 *     state, which would just be a broken drawing.
 *   · The FINEST rung overflows about half of them, and that is what leaning in
 *     means: bigger marks, less of a day, and dragging the pane taller or
 *     pinching back out is the way to see the rest.
 *
 * A first pass at this ladder made every day at the three tightest rungs
 * overflow, which looked plausible in the abstract and was useless in the hand.
 * The heights here are what the data allows, not what a round number wanted.
 */
export const PANE_ZOOMS: readonly PaneZoom[] = [
  { colWidth: 4, pxPerChar: 0.014, gap: 0.5, minCard: 0.8 },
  { colWidth: 7, pxPerChar: 0.020, gap: 0.8, minCard: 1.3 },
  { colWidth: 11, pxPerChar: 0.026, gap: 1.0, minCard: 1.7 },
  { colWidth: 16, pxPerChar: 0.032, gap: 1.3, minCard: 2.1 },
  { colWidth: 22, pxPerChar: 0.038, gap: 1.6, minCard: 2.6 },
];

export const PANE_ZOOM_DEFAULT = 1;

/** How far a jump moves, and the floor under the colour ramp. */
export type PaneJump = 'week' | 'month';

export const JUMP_DAYS: Record<PaneJump, number> = { week: 7, month: 30 };

/**
 * How many half-lives of the ramp fit across the visible span.
 *
 * Four, so the oldest thing on screen lands at 2^-4 — near enough to black to
 * read as "the old end" while still being a colour rather than a hole.
 */
const RAMP_HALF_LIVES = 4;

/** "2026-08-21" → a whole number of days, for arithmetic that can't drift.
 * Parsed as UTC so a browser west of Greenwich can't shift the date by one. */
export function dayNumber(day: string): number {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) ? NaN : Math.floor(at / 86_400_000);
}

/** A whole number of days back → "YYYY-MM-DD". */
export function dayFromNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** How tall one card draws: how much was written, capped, floored so it can
 * never vanish. */
export function markHeight(chars: number, z: PaneZoom): number {
  const written = Math.min(Math.max(0, chars || 0), CHAR_CAP);
  return Math.max(z.minCard, written * z.pxPerChar);
}

/**
 * A card's place on the heat ramp, 0..1 — 1 is the freshest thing in view.
 *
 * Relative to the WINDOW, not to today. At this size the pane's job isn't to
 * tell her a stretch is old (she knows; she scrolled there) — it's to show the
 * texture of whatever she's looking at, and an absolute ramp would render every
 * scroll into the past as a black box. So the newest card on screen is always
 * the bright end and the oldest is always the dark one.
 *
 * `spanDays` is FLOORED by the caller at the jump unit, and that floor is what
 * keeps this honest. Without it, zooming until only a few hours are on screen
 * would spread one ordinary afternoon across the entire black-to-red ramp and
 * dress it up as a dramatic sunset. Floored, a single day inside a week-long
 * ramp simply reads uniformly hot, which is the truth.
 */
export function markHeat(ageDays: number, spanDays: number): number {
  const halfLife = Math.max(spanDays, 1) / RAMP_HALF_LIVES;
  return 2 ** (-Math.max(0, ageDays) / halfLife);
}

/** One drawn card. */
export interface PaneMark {
  /** Its place in its day, oldest first — a stable key across renders. */
  index: number;
  chars: number;
  /** Top of the rectangle, relative to the drawing box. */
  y: number;
  h: number;
  /** 0..1 for heatColor(). */
  t: number;
}

/** One drawn day. */
export interface PaneColumn {
  day: string;
  /** Left edge, relative to the drawing box. May be negative — the box clips. */
  x: number;
  w: number;
  cards: number;
  marks: PaneMark[];
  /** The day stacked higher than the box: it went over the rim. */
  overflow: boolean;
}

export interface PaneLayout {
  columns: PaneColumn[];
  /** The whole drawing, first day to last — what scrolling is bounded by. */
  totalWidth: number;
  /** How far back scrolling can actually go, given the box. */
  maxScroll: number;
  /** The scroll actually used, after clamping. */
  scrollX: number;
  /** The stretch on screen, for the pane's caption. Null when nothing is. */
  from: string | null;
  to: string | null;
  /** Days the colour ramp is spread across — the visible span, floored. */
  spanDays: number;
}

export interface PaneOptions {
  /** The drawing box, in CSS px. */
  width: number;
  height: number;
  zoom: PaneZoom;
  /** How far back from the newest day, in px. 0 pins the pane to now. */
  scrollX: number;
  /** Sets the floor under the colour ramp. */
  jump: PaneJump;
}

/**
 * Place every card in view.
 *
 * Days that hold no cards get no column and simply leave a gap — a fallow
 * stretch is a real part of the shape, and at this size the honest thing is to
 * show the water missing rather than to close the days up around it.
 *
 * Only the columns that actually intersect the box are built. The pond is
 * forty-seven days today and will be years of them; laying out every card in
 * the record on every frame of a drag is the difference between a pane that
 * moves with her finger and one that stutters.
 */
export function layoutPane(days: readonly SizedDay[], options: PaneOptions): PaneLayout {
  const { width, height, zoom, jump } = options;
  const empty: PaneLayout = {
    columns: [], totalWidth: 0, maxScroll: 0, scrollX: 0,
    from: null, to: null, spanDays: JUMP_DAYS[jump],
  };
  const usable = days.filter((d) => !Number.isNaN(dayNumber(d.day)));
  if (usable.length === 0 || width <= 0 || height <= 0) return empty;

  const first = usable.reduce((m, d) => Math.min(m, dayNumber(d.day)), Infinity);
  const last = usable.reduce((m, d) => Math.max(m, dayNumber(d.day)), -Infinity);
  // Inclusive of both ends, so the newest day is a whole column and not a line.
  const totalWidth = (last - first + 1) * zoom.colWidth;
  const maxScroll = Math.max(0, totalWidth - width);
  const scrollX = Math.min(Math.max(0, options.scrollX), maxScroll);
  // World x sitting at the pane's left edge. Scroll 0 pins the newest day to
  // the right-hand edge, which is where she is when she opens it.
  const leftEdge = totalWidth - width - scrollX;

  // The ramp spreads across what's on screen, never tighter than a jump unit.
  const visibleDays = width / zoom.colWidth;
  const spanDays = Math.max(visibleDays, JUMP_DAYS[jump]);

  // Which days are actually on screen, worked out BEFORE any of them is
  // coloured. The ramp's hot end is the newest day in view, and that can only
  // be known once the whole visible set is. Measuring from the pane's right
  // EDGE instead — which is a day later than the last column — left the
  // freshest card in the pond permanently a shade off full red.
  const onScreen: { day: SizedDay; x: number }[] = [];
  for (const day of usable) {
    const x = (dayNumber(day.day) - first) * zoom.colWidth - leftEdge;
    if (x + zoom.colWidth <= 0 || x >= width) continue;
    onScreen.push({ day, x });
  }
  const newest = onScreen.reduce((m, e) => Math.max(m, dayNumber(e.day.day)), -Infinity);

  const columns: PaneColumn[] = [];
  for (const { day, x } of onScreen) {
    const age = Math.max(0, newest - dayNumber(day.day));
    const t = markHeat(age, spanDays);
    // The mark is inset inside its column, so neighbouring days stay apart
    // too — the gaps run both ways or the columns fuse into a solid block.
    const inset = Math.min(zoom.gap, zoom.colWidth / 4);
    const w = Math.max(1, zoom.colWidth - inset * 2);

    const marks: PaneMark[] = [];
    let overflow = false;
    let bottom = height;
    const lengths = day.chars ?? [];
    for (let i = 0; i < lengths.length; i += 1) {
      const h = markHeight(lengths[i], zoom);
      const y = bottom - h;
      bottom = y - zoom.gap;
      if (y + h <= 0) {
        // Stacked clean off the top of the box. Everything above it is too,
        // so stop building marks nothing can see.
        overflow = true;
        break;
      }
      if (y < 0) overflow = true;
      marks.push({ index: i, chars: lengths[i], y, h, t });
    }

    columns.push({ day: day.day, x: x + inset, w, cards: day.cards, marks, overflow });
  }

  const shown = columns.map((c) => c.day).sort();
  return {
    columns,
    totalWidth,
    maxScroll,
    scrollX,
    from: shown[0] ?? null,
    to: shown[shown.length - 1] ?? null,
    spanDays,
  };
}

/** "2026-08-21" → "Aug 21". The pane's caption — the only words on it, and the
 * thing that keeps a window-relative colour ramp from being a claim about
 * today. */
export function paneDate(day: string): string {
  const [, month, date] = day.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(month) - 1] ?? month} ${Number(date)}`;
}

/** The stretch on screen, said in as few words as it takes. */
export function paneCaption(layout: PaneLayout): string {
  if (!layout.from || !layout.to) return '';
  if (layout.from === layout.to) return paneDate(layout.from);
  return `${paneDate(layout.from)} – ${paneDate(layout.to)}`;
}
