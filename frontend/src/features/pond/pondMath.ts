/**
 * pondMath.ts — where every card sits in the pond, and where a thread's line runs.
 *
 * The pond is the journal drawn as a place rather than a feed: time runs left
 * to right, one column per day. What changes down the column is the thing you
 * pick — the pond has TWO ARRANGEMENTS, and they answer different questions:
 *
 *   CLOCK — each card sits at the hour it was written. Answers *when*. The 2am
 *           cards sit low, the morning ones high, a quiet day is a nearly empty
 *           column, and her sleep schedule is visible in the shape. Cards are
 *           dots here, because at this density nothing else would read.
 *
 *   WORDS — the clock is dropped and cards stack flush, each one as tall as it
 *           has words to fill. Answers *how much*. A day she wrote three lines
 *           is a stub; a day she poured out is a tall ribbon of text. The
 *           column height IS the volume, and because nothing is spaced by time
 *           there are no gaps and no collisions — which is exactly what makes
 *           room for the words to actually be legible.
 *
 * That pairing is the whole design. Clock mode can't show text (two cards
 * written a minute apart are a pixel apart), and words mode can't show time
 * (nothing is where the clock put it). Neither is the "real" one — they're the
 * two axes a day has, and the toggle is how you look down each.
 *
 * This module is only the arithmetic. It takes the cards the API returned and
 * answers two questions — where does each card BOX go, and what path connects
 * one thread's cards — with no React, no DOM and no fetching, so both can be
 * tested directly. Everything comes back as a rectangle (x/y/w/h) in both
 * modes: a dot is just a 7px-square box. PondView.tsx positions real elements
 * at those coordinates; routes/pond.py supplies the cards.
 *
 * Prompt that produced it: "make it so it can be organized by time or just by
 * the words in the journal — I want the words to be tiny and the cards to show."
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
  /** The card's whole text, whitespace collapsed (capped server-side). */
  body: string;
}

/** What a card shows in words mode: its full text, or a window onto it. */
export interface Excerpt {
  text: string;
  /** True when text was cut away before/after — the drawing shows an ellipsis. */
  clippedHead: boolean;
  clippedTail: boolean;
}

/** The two ways a day can be read down: by the clock, or by the words. */
export type PondMode = 'clock' | 'words';

export interface PlacedCard {
  card: PondCard;
  /** Top-left of the card's box. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Minutes past midnight, or null if the card had no usable time. */
  minutes: number | null;
  /** What this card shows in words mode. Null in clock mode — a dot has no text. */
  text: Excerpt | null;
}

export interface DayColumn {
  day: string;
  /** Left edge of the column. */
  x: number;
  /** Centre of the column — where the day label and the thread line sit. */
  cx: number;
  cards: PlacedCard[];
}

export interface PondLayout {
  mode: PondMode;
  columns: DayColumn[];
  width: number;
  height: number;
  colWidth: number;
}

export interface PondLayoutOptions {
  mode: PondMode;
  /** Horizontal room per day. */
  colWidth: number;
  /** Where the drawing starts — leaves room for the day labels. */
  top: number;
  /** CLOCK only: how tall a full 24 hours is drawn. */
  dayHeight: number;
  /** CLOCK only: a dot's diameter. Scales with zoom. */
  dotSize: number;
  /** WORDS only: the tiny type the cards are set in. */
  fontSize: number;
  /** WORDS only: vertical breathing room between stacked cards. */
  cardGap: number;
  /**
   * WORDS only: a card shorter than this shows in FULL — most cards are, and a
   * journal entry cut off mid-sentence for tidiness isn't worth reading.
   * Measured against this vault: 90% of cards are under ~570 characters.
   */
  fullBelow: number;
  /**
   * WORDS only: how much of a long card to show on EACH SIDE of the place it
   * mentions the lit thread. Enough to land in the middle of a thought rather
   * than a fragment of one.
   */
  context: number;
  /**
   * When set, ONLY cards carrying one of these tags are placed — but the day
   * columns still come from every card, so the days a thread never touched stay
   * standing as empty gaps. That's deliberate: the silence between two
   * appearances is part of a thread's shape, and closing the gaps would both
   * hide it and make every column jump sideways the moment she toggles this.
   */
  only: ReadonlySet<string> | null;
  /**
   * The words a long card's excerpt centres on — the lit thread's slug, name
   * and aliases, broken into their parts by routes/pond.py. Null when nothing
   * is lit, in which case long cards simply show from the top.
   */
  terms: readonly string[] | null;
}

export const DEFAULT_LAYOUT: PondLayoutOptions = {
  mode: 'clock',
  colWidth: 34,
  top: 28,
  dayHeight: 760,
  dotSize: 7,
  fontSize: 13,
  cardGap: 4,
  fullBelow: 600,
  context: 220,
  only: null,
  terms: null,
};

/** A dot's diameter at the default zoom. */
export const DOT = DEFAULT_LAYOUT.dotSize;


/**
 * How many days to skip between drawn date labels, so they never overlap.
 * At four pixels a day there is no room for "Aug 9" on every column; showing
 * every Nth keeps the axis readable instead of turning it into a smear.
 */
export function labelStep(colWidth: number): number {
  return Math.max(1, Math.ceil(30 / Math.max(1, colWidth)));
}

const MINUTES_PER_DAY = 1440;

/**
 * The rail's "Unfiled" row lights the cards that belong to NO thread — a
 * quarter of the journal, invisible to every tag-based view. It can't be a
 * real tag (the whole point is the absence of one), so it's this sentinel:
 * a lit set containing it matches exactly the cards with an empty tag list.
 * Underscored so it can never collide with a real slug (TAG_RE forbids
 * underscores everywhere tags are minted).
 */
export const UNFILED = '__unfiled__';

/** Does a card match a lit set — by carrying one of its tags, or by carrying
 * none at all when the set asks for the unfiled. */
export function matchesLit(card: PondCard, tags: ReadonlySet<string>): boolean {
  if (tags.has(UNFILED) && card.tags.length === 0) return true;
  return card.tags.some((t) => tags.has(t));
}

/**
 * A card's timestamp → minutes past midnight.
 *
 * Accepts both a bare clock time ("09:00", "09:00:30") and the pool's actual
 * format, a full datetime ("2026-07-06 08:46:00") — the time-of-day is pulled
 * from wherever it sits. THE DATETIME CASE IS THE ONE THAT MATTERS: this
 * function originally demanded the clock at the start of the string, so every
 * real card parsed to null, every card sank to the "untimed" slot at the
 * bottom of its day, and the time axis silently never worked — each collision
 * strategy just spread the bottom pile into a different wrong shape. If this
 * regresses, the pond doesn't error; it quietly draws nonsense. The tests pin
 * the datetime format for exactly that reason.
 *
 * Anything without a real clock time comes back null rather than 0 — a card
 * with no time is a different thing from a card written at midnight, and
 * collapsing them would put a silent pile at the top of the column.
 */
export function parseMinutes(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const m = /(?:^|[ T])(\d{1,2}):(\d{2})(?::\d{2})?/.exec(ts.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** The clock part of a timestamp, for display — "2026-07-06 08:46:00" → "08:46".
 * Null when there's no real time to show. */
export function clockOf(ts: string | null | undefined): string | null {
  const minutes = parseMinutes(ts);
  if (minutes === null) return null;
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/** Distinct days present, ascending. */
export function pondDays(cards: readonly PondCard[]): string[] {
  return [...new Set(cards.map((c) => c.day))].sort();
}

/**
 * Where a card says one of a thread's words, or -1.
 *
 * Two rules, both of which exist because a naive version puts the window in the
 * wrong place:
 *
 *   WHOLE WORDS ONLY. Substring matching would centre `trans` on "transit" and
 *   `will` on "willing" — a window on a sentence that has nothing to do with
 *   the thread, quietly lying about why it's showing you that passage.
 *
 *   MOST DISTINCTIVE TERM WINS, not the earliest. Threads are aliased in
 *   natural language ("back under supervision", "complaints about me"), so
 *   their word lists carry ordinary words like *back* and *about* beside
 *   *supervision* and *probation*. Earliest-wins would centre on whichever
 *   filler word happened to appear first, which lands almost anywhere. Longer
 *   words are rarer and carry the thread's actual sense, so terms are tried
 *   longest-first and the first one that appears at all decides the spot. The
 *   common words stay in the list — they're a real fallback when nothing
 *   sharper is in the card — they just never outrank a specific one.
 */
export function findTerm(
  body: string,
  terms: readonly string[] | null | undefined,
): number {
  if (!terms || terms.length === 0) return -1;
  const hay = body.toLowerCase();
  const isEdge = (ch: string) => ch === '' || !/[a-z0-9]/.test(ch);
  const ranked = [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));

  for (const term of ranked) {
    const needle = term.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? '' : hay[at - 1];
      const after = hay[at + needle.length] ?? '';
      if (isEdge(before) && isEdge(after)) return at;
      from = at + 1;
    }
  }
  return -1;
}

/**
 * What a card SHOWS: the whole thing when it's short, a window when it isn't.
 *
 * Most cards are short — nine in ten are under six hundred characters — and
 * those show in full, because a journal entry truncated for tidiness isn't
 * worth reading. A long card is windowed instead, and the window is placed
 * where the card actually mentions the lit thread, so a fifteen-thousand
 * character day surfaces the part that's about `housing` rather than whatever
 * happened to be typed first.
 *
 * Two honesty rules hold this together:
 *
 *   · The window snaps OUT to word boundaries, never mid-word.
 *   · When nothing is lit, or the card never says any of the thread's words
 *     (about one long card in seven here), it falls back to the head and says
 *     so with an ellipsis — rather than inventing a relevant passage. The
 *     ellipsis is the drawing admitting there's more, which is the only honest
 *     thing it can do.
 */
export function excerpt(
  body: string,
  terms: readonly string[] | null,
  options: Partial<Pick<PondLayoutOptions, 'fullBelow' | 'context'>> = {},
): Excerpt {
  const fullBelow = options.fullBelow ?? DEFAULT_LAYOUT.fullBelow;
  const context = options.context ?? DEFAULT_LAYOUT.context;
  const text = body ?? '';
  if (text.length <= fullBelow) {
    return { text, clippedHead: false, clippedTail: false };
  }

  const at = findTerm(text, terms);
  let start = at === -1 ? 0 : Math.max(0, at - context);
  let end = at === -1 ? fullBelow : Math.min(text.length, at + context);

  // Snap outward to whitespace so the window never begins or ends mid-word.
  if (start > 0) {
    const space = text.lastIndexOf(' ', start);
    start = space === -1 ? 0 : space + 1;
  }
  if (end < text.length) {
    const space = text.indexOf(' ', end);
    end = space === -1 ? text.length : space;
  }

  return {
    text: text.slice(start, end),
    clippedHead: start > 0,
    clippedTail: end < text.length,
  };
}

/**
 * How tall a card needs to be to show its words.
 *
 * The card is sized to hold ALL of its excerpt — no line cap. A card runs its
 * full length (or the full length of its window), because the point of words
 * mode is reading, and a card cut off at six lines is a card you have to tap to
 * finish. What bounds the tall ones is `excerpt`, which windows them, not a
 * clip here.
 *
 * Deliberately an ESTIMATE, not a measurement: measuring 1,100 cards means
 * 1,100 forced layouts and a visibly janky first paint. The estimate assumes an
 * average glyph is about half the font size wide — close enough for
 * proportional text that the column reads right. It rounds UP by a line so a
 * slightly-wrong guess leaves a sliver of empty space rather than shaving the
 * last line off the text.
 */
export function cardHeight(
  text: string,
  width: number,
  opt: Pick<PondLayoutOptions, 'fontSize'>,
): number {
  const padX = 5;
  const padY = 4;
  const lineHeight = Math.round(opt.fontSize * 1.35);
  const perLine = Math.max(1, Math.floor((width - padX * 2) / (opt.fontSize * 0.5)));
  const lines = Math.max(1, Math.ceil((text || '').length / perLine));
  return lines * lineHeight + padY * 2;
}

/**
 * Place every card. Days become columns left to right; within a column cards
 * are ordered by time (untimed ones last, then by id so the order is stable
 * between renders) and then laid out according to the mode.
 */
export function layoutPond(
  cards: readonly PondCard[],
  options: Partial<PondLayoutOptions> = {},
): PondLayout {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  // Filtering CLOSES the days it empties. Keeping them as gaps preserved the
  // silence between appearances, but a thread touching ten days out of thirty-
  // five then spent two-thirds of the width on blank columns — and the point of
  // this filter is reading the thread, which wants the words next to each other.
  // The full pond is one toggle away, and the unfiltered view still holds the
  // silence.
  const kept = opt.only ? cards.filter((c) => matchesLit(c, opt.only!)) : cards;
  const days = pondDays(kept);
  const byDay = new Map<string, PondCard[]>();
  for (const card of kept) {
    const list = byDay.get(card.day);
    if (list) list.push(card);
    else byDay.set(card.day, [card]);
  }

  // Clock mode always draws the full 24 hours even on a quiet day — the empty
  // room IS the information. Words mode has no floor: an empty day is short.
  let lowest = opt.mode === 'clock' ? opt.top + opt.dayHeight : opt.top;
  const boxWidth =
    opt.mode === 'clock' ? opt.dotSize : Math.max(8, opt.colWidth - opt.cardGap * 2);

  const columns: DayColumn[] = days.map((day, index) => {
    const x = index * opt.colWidth;
    const cx = x + opt.colWidth / 2;
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

    let cursor = opt.top;
    // NO collision handling, and that's the design, arrived at the long way
    // round. Pushing colliding dots down the column drew them at times she
    // didn't write; stepping them sideways drew entries minutes apart as a
    // side-by-side row. Both were the layout lying to protect the layout. So:
    // every dot sits at EXACTLY its minute, dead centre of its day, and close
    // times simply overlap. The dots are translucent (PondView's CSS), so a
    // pile of entries reads as a darker blot — density becomes ink, the way a
    // real scatter plot handles it. Picking one card out of a tight cluster
    // is what zooming in is for.
    const placed = ordered.map((card) => {
      const minutes = parseMinutes(card.ts);
      let y: number;
      let h: number;
      let text: Excerpt | null = null;
      if (opt.mode === 'clock') {
        h = opt.dotSize;
        y =
          minutes === null
            ? opt.top + opt.dayHeight
            : opt.top + (minutes / MINUTES_PER_DAY) * opt.dayHeight;
      } else {
        // Words mode: no clock, no collisions — just stack them. The column
        // ends up exactly as tall as the day's words, which is the point.
        text = excerpt(card.body, opt.terms, opt);
        h = cardHeight(text.text, boxWidth, opt);
        y = cursor;
        cursor = y + h + opt.cardGap;
      }
      const bottom = y + h;
      if (bottom > lowest) lowest = bottom;
      return {
        card,
        x: opt.mode === 'clock' ? cx - opt.dotSize / 2 : x + opt.cardGap,
        y,
        w: boxWidth,
        h,
        minutes,
        text,
      };
    });

    return { day, x, cx, cards: placed };
  });

  return {
    mode: opt.mode,
    columns,
    colWidth: opt.colWidth,
    width: Math.max(days.length * opt.colWidth, opt.colWidth),
    height: lowest + opt.dotSize * 2,
  };
}

/**
 * The cards a lit selection touches, in time order.
 *
 * Takes a SET, not one tag, because a front is a set of threads — lighting
 * "Connection" lights the eight threads filed under it at once, and the line
 * should run through all of them as one shape rather than eight.
 */
export function threadPoints(
  layout: PondLayout,
  tags: ReadonlySet<string> | null,
): PlacedCard[] {
  if (!tags || tags.size === 0) return [];
  const hits: PlacedCard[] = [];
  for (const column of layout.columns) {
    for (const placed of column.cards) {
      if (matchesLit(placed.card, tags)) hits.push(placed);
    }
  }
  return hits;
}

/**
 * The polyline for a lit selection: through the centre of EVERY card, at every
 * zoom, in time order.
 *
 * No averaging, ever — an earlier version collapsed each day to its mean
 * height once the columns got narrow, and the auto-fit zoom promptly landed
 * the whole page in that regime, so the line "reverted" to a smoothed shape
 * nobody asked for. Her call: the line's job is to touch the actual entries.
 * A busy day draws a vertical run down the column and that's honest — those
 * cards are all there, at those times.
 *
 * It stays one continuous path across every day the thread touches, gaps
 * included — the long flat stretch between two appearances is the silence, and
 * it's as much a part of the thread's shape as the busy stretches. Breaking
 * the line at gaps would draw a set of episodes; joining it draws a life.
 */
export function threadLine(
  layout: PondLayout,
  tags: ReadonlySet<string> | null,
): { x: number; y: number }[] {
  return threadPoints(layout, tags).map((p) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 }));
}

/** An SVG `points` string for a thread's polyline. */
export function polylinePoints(points: readonly { x: number; y: number }[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/**
 * Hour gridlines worth drawing, as {y, label} — every 6 hours. Enough to read
 * morning from night without ruling the whole surface into a spreadsheet.
 * Clock mode only: in words mode there is no clock to rule.
 */
export function hourLines(
  options: Partial<PondLayoutOptions> = {},
): { y: number; label: string }[] {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  if (opt.mode === 'words') return [];
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
