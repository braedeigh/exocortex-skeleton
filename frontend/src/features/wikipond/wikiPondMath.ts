/**
 * wikiPondMath.ts — where every wiki row sits in the wiki-pond, and where a
 * lit tag's line runs.
 *
 * Plain English: the pond already draws the JOURNAL as a place — one column
 * per day, time running left to right. This does the same trick for
 * EVERYTHING tagged: journal cards, research entries, build commits and
 * todos, all four side by side inside the same day column, in four thin
 * vertical LANES (fixed order: journal | research | build | todo). Clock mode
 * puts each row at its own hour, the way the pond puts a card at its own
 * minute. Words mode drops the clock and stacks rows flush by how much text
 * they hold — but only journal and research HAVE prose worth stacking, so
 * build and todo simply switch off in that mode, the same way the pond's own
 * working lane switches off in words mode: "the layer switches off rather
 * than pretending."
 *
 * This module is pure arithmetic — no React, no DOM, no fetching — so it can
 * be tested directly, same split as pondMath.ts. It reuses pondMath's own
 * building blocks wherever the shapes genuinely match (a wiki row's time
 * parses exactly the way a card's does; the tiny-type excerpt machinery, the
 * hour ruler, the day labels and the SVG polyline formatter don't need a
 * second copy). What's new here is the LANE axis pondMath never had to think
 * about, because the pond only ever drew one family.
 *
 * Design doc: docs/tags-architecture.md, "Wiki-pond UI" section. Read
 * alongside WikiPond.tsx, which is the file the prompt below actually
 * produced — this module is its arithmetic half.
 *
 * Prompt that produced it: "the wiki gets the pond UI — day columns and
 * lanes for journal, research, build and todos, a rail grouped by tag
 * namespace, lighting as emphasis not filter, and tag chips editable where
 * she notices them."
 */
import {
  cardHeight,
  clockOf,
  dayLabel,
  excerpt,
  findTerm,
  hourLines,
  labelStep,
  parseMinutes,
  polylinePoints,
  type Excerpt,
} from '../terrain/pond/pondMath';

// Re-exported rather than re-implemented — WikiPond.tsx imports its clock
// labels, day labels, hour ruler and excerpt windowing from HERE, and this is
// the one place that decides which of those are pondMath's own vs wikipond's
// own. (See the file-block above for why each one is a straight reuse.)
export { cardHeight, clockOf, dayLabel, excerpt, findTerm, hourLines, labelStep, polylinePoints };
export type { Excerpt };

/** The four families the API returns (routes/wiki.py's GET /api/wiki/pond),
 * in the FIXED lane order the doc specifies — this array's order IS the
 * left-to-right lane order drawn inside every day column. */
export const FAMILIES = ['journal', 'research', 'build', 'todo'] as const;
export type WikiFamily = (typeof FAMILIES)[number];

/** Words mode has no clock to hang build/todo on (they're not prose you'd
 * stack and read), so only these two lanes exist there — same call the
 * pond's own working lane makes about words mode. */
export const WORDS_FAMILIES: readonly WikiFamily[] = ['journal', 'research'];

/** One ns:tag pair — the address a tag chip and a rail row both speak. */
export interface WikiTagRef {
  ns: string;
  tag: string;
}

/** One row of the wiki-pond, as routes/wiki.py returns it — a journal card,
 * a research entry, a build commit, or a todo, already flattened to one
 * shape so the layout code never has to know which. */
export interface WikiRow {
  id: string;
  family: WikiFamily;
  day: string;
  /** "HH:MM[:SS]" or a full datetime — same formats parseMinutes reads for
   * the pond. Null when nothing recorded a time. */
  ts: string | null;
  title: string;
  body: string;
  tags: WikiTagRef[];
}

/** The rail, grouped by namespace — GET /api/wiki/pond's `rail` field. */
export interface WikiRailTag {
  tag: string;
  count: number;
  span: number;
}
export interface WikiRailNs {
  ns: string;
  tags: WikiRailTag[];
}

export type WikiMode = 'clock' | 'words';

export interface PlacedRow {
  row: WikiRow;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index into the ACTIVE lane order for this mode (FAMILIES in clock mode,
   * WORDS_FAMILIES in words mode) — which lane this row's box sits in. */
  lane: number;
  minutes: number | null;
  /** Words mode only — what the box shows. Null in clock mode, same as
   * pondMath's PlacedCard. */
  text: Excerpt | null;
}

export interface WikiDayColumn {
  day: string;
  x: number;
  cx: number;
  rows: PlacedRow[];
}

export interface WikiPondLayout {
  mode: WikiMode;
  columns: WikiDayColumn[];
  width: number;
  height: number;
  colWidth: number;
  /** The lanes actually drawn this mode, left to right — FAMILIES or
   * WORDS_FAMILIES. WikiPond.tsx reads this to know how many lane dividers
   * and lane-header labels to draw without duplicating the mode check. */
  families: readonly WikiFamily[];
}

export interface WikiLayoutOptions {
  mode: WikiMode;
  /** Horizontal room per day — split evenly across the active lanes. */
  colWidth: number;
  top: number;
  /** CLOCK only: how tall a full 24 hours is drawn. */
  dayHeight: number;
  /** CLOCK only: a dot's diameter. */
  dotSize: number;
  /** WORDS only: the tiny type the cards are set in. */
  fontSize: number;
  /** WORDS only: vertical gap between stacked cards. */
  cardGap: number;
  fullBelow: number;
  context: number;
  /** The lit tag's words, for excerpt() to window a long card onto — same
   * role `terms` plays in pondMath's PondLayoutOptions. */
  terms: readonly string[] | null;
}

export const DEFAULT_WIKI_LAYOUT: WikiLayoutOptions = {
  mode: 'clock',
  // Wider than the pond's own 34px column: this column has to hold FOUR
  // lanes side by side rather than one, so each lane needs its own sliver of
  // room even at the default zoom.
  colWidth: 72,
  top: 28,
  dayHeight: 760,
  dotSize: 7,
  fontSize: 13,
  cardGap: 4,
  fullBelow: 600,
  context: 220,
  terms: null,
};

/** Distinct days present, ascending — pondMath's pondDays, renamed for this
 * module's own row shape (kept as a straight reimplementation rather than a
 * generic import: sharing one `{day}`-shaped helper across two feature
 * modules isn't worth the coupling for a three-line function). */
export function wikiPondDays(rows: readonly WikiRow[]): string[] {
  return [...new Set(rows.map((r) => r.day))].sort();
}

/** Does a row carry a given ns:tag? What "lit" means here — singular, unlike
 * the pond's `matchesLit`, because a wiki-pond tag is never a bundle of
 * others the way a front bundles threads (nothing in the tags schema plays
 * that role for the wiki yet — see docs/tags-architecture.md). */
export function matchesWikiTag(row: WikiRow, lit: WikiTagRef | null): boolean {
  if (!lit) return false;
  return row.tags.some((t) => t.ns === lit.ns && t.tag === lit.tag);
}

/**
 * Place every row. Days become columns left to right (most recent at the
 * right, same as the pond); within a column each ACTIVE family gets its own
 * lane, and within a lane rows are ordered by time — untimed ones last, then
 * by id so renders don't jitter — before being laid out per the mode.
 *
 * Day columns are built from EVERY row, not just the ones this mode will
 * draw: a day that only had a commit and a todo still gets a column in words
 * mode, empty though its journal/research lanes are. Closing days that a
 * switched-off lane touched would make toggling the mode silently reshuffle
 * the horizontal axis, which is exactly the kind of lie pondMath's own
 * layoutPond refuses to tell (see its `only` filter's comment on why it
 * DOES close days there — a deliberate ask, not the default).
 */
export function layoutWikiPond(
  rows: readonly WikiRow[],
  options: Partial<WikiLayoutOptions> = {},
): WikiPondLayout {
  const opt = { ...DEFAULT_WIKI_LAYOUT, ...options };
  const families: readonly WikiFamily[] = opt.mode === 'clock' ? FAMILIES : WORDS_FAMILIES;
  const days = wikiPondDays(rows);

  const placeable = opt.mode === 'words'
    ? rows.filter((r) => (WORDS_FAMILIES as readonly string[]).includes(r.family))
    : rows;

  const byDayFamily = new Map<string, WikiRow[]>();
  for (const row of placeable) {
    const key = `${row.day} ${row.family}`;
    const list = byDayFamily.get(key);
    if (list) list.push(row);
    else byDayFamily.set(key, [row]);
  }

  const laneWidth = opt.colWidth / families.length;
  const boxWidth = opt.mode === 'clock' ? opt.dotSize : Math.max(8, laneWidth - opt.cardGap * 2);

  // Clock mode always draws the full 24 hours, same reasoning as the pond:
  // the empty room is information. Words mode has no floor.
  let lowest = opt.mode === 'clock' ? opt.top + opt.dayHeight : opt.top;

  const columns: WikiDayColumn[] = days.map((day, index) => {
    const x = index * opt.colWidth;
    const cx = x + opt.colWidth / 2;
    const placed: PlacedRow[] = [];

    families.forEach((family, lane) => {
      const laneRows = byDayFamily.get(`${day} ${family}`) ?? [];
      const ordered = [...laneRows].sort((a, b) => {
        const am = parseMinutes(a.ts);
        const bm = parseMinutes(b.ts);
        if (am === null && bm === null) return a.id.localeCompare(b.id);
        if (am === null) return 1;
        if (bm === null) return -1;
        return am - bm || a.id.localeCompare(b.id);
      });

      const laneX = x + lane * laneWidth;
      // Independent cursor PER LANE in words mode — journal and research
      // stack flush against their own top, not against each other's bottom.
      let cursor = opt.top;

      for (const row of ordered) {
        const minutes = parseMinutes(row.ts);
        let rowY: number;
        let rowH: number;
        let text: Excerpt | null = null;

        if (opt.mode === 'clock') {
          rowH = opt.dotSize;
          rowY = minutes === null
            ? opt.top + opt.dayHeight
            : opt.top + (minutes / 1440) * opt.dayHeight;
        } else {
          text = excerpt(row.body, opt.terms, opt);
          rowH = cardHeight(text.text, boxWidth, opt);
          rowY = cursor;
          cursor = rowY + rowH + opt.cardGap;
        }

        const bottom = rowY + rowH;
        if (bottom > lowest) lowest = bottom;

        placed.push({
          row,
          x: opt.mode === 'clock'
            ? laneX + laneWidth / 2 - opt.dotSize / 2
            : laneX + opt.cardGap,
          y: rowY,
          w: boxWidth,
          h: rowH,
          lane,
          minutes,
          text,
        });
      }
    });

    // Stable draw/walk order: lane left to right, then time within a lane —
    // matches how the eye actually scans the column.
    placed.sort((a, b) =>
      a.lane - b.lane
      || (a.minutes ?? Number.POSITIVE_INFINITY) - (b.minutes ?? Number.POSITIVE_INFINITY)
      || a.row.id.localeCompare(b.row.id));

    return { day, x, cx, rows: placed };
  });

  return {
    mode: opt.mode,
    columns,
    colWidth: opt.colWidth,
    width: Math.max(days.length * opt.colWidth, opt.colWidth),
    height: lowest + (opt.mode === 'clock' ? opt.dotSize * 2 : 0),
    families,
  };
}

/**
 * Every row a lit tag touches, in the same left-to-right / lane / time order
 * the layout already put them in — pondMath's `threadPoints`, generalized
 * from a set-of-tags match to the wiki's single ns:tag match.
 */
export function wikiTagRows(
  layout: WikiPondLayout,
  lit: WikiTagRef | null,
): PlacedRow[] {
  if (!lit) return [];
  const hits: PlacedRow[] = [];
  for (const column of layout.columns) {
    for (const placed of column.rows) {
      if (matchesWikiTag(placed.row, lit)) hits.push(placed);
    }
  }
  return hits;
}

/**
 * The polyline for a lit tag: through the centre of every row it touches,
 * across every day and every lane it ever sat in. No averaging, no
 * day-collapsing — pondMath's `threadLine` makes the case for why (a
 * "smoothed" line lies about which entries are actually there), and it holds
 * here just the same, PLUS a second axis pondMath never had to cross: the
 * line can jump lanes mid-path (a tag lit on a journal row Tuesday and a
 * build row Wednesday draws exactly that jump), which is honest — the tag
 * really did move families.
 */
export function wikiThreadLine(
  layout: WikiPondLayout,
  lit: WikiTagRef | null,
): { x: number; y: number }[] {
  return wikiTagRows(layout, lit).map((p) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 }));
}
