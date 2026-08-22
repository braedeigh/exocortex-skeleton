/**
 * creekMath.ts — where every file/collection row sits, and where the ribbon
 * between them runs.
 *
 * The creek draws data movement LITERALLY: code files on the left bank, vault
 * collections on the right bank, ribbons of flow between them. This module is
 * only the arithmetic — it takes the `/api/creek` payload (files with their
 * calls, collections with their traffic) and answers three questions, with no
 * React, no DOM and no fetching, so all three are testable directly:
 *
 *   WHERE does each row sit — grouped (server/routes/scripts/tools on the left;
 *   sql/json on the right), sorted by whichever count is currently on screen
 *   (`sortMetricFor`: writes desc when writes are drawn, reads desc when
 *   reads-only), at a FIXED row height, so a ribbon's endpoint is computed
 *   from the same numbers that placed the row rather than measured off the
 *   rendered DOM.
 *
 *   HOW WIDE is a ribbon — writes are normally the story and get the pond's
 *   own log-ramp-with-floor idiom (a flow that exists is never invisible);
 *   reads are normally context and stay hairline-thin on a completely
 *   different scale. In reads-only mode (the Writes chip off) reads BECOME
 *   the story and get that same log-ramp idiom on their OWN cap — still never
 *   sharing an axis with writes, still never drawn in `--accent` (writes own
 *   that colour alone) — see `ribbonRenderWidth`.
 *
 *   WHAT lights and what dims when she taps a file or a collection — emphasis,
 *   never a filter: the rest of the creek stays drawn, just quieter, the same
 *   grammar the pond uses for a lit thread.
 *
 * CreekView.tsx only draws what this returns and positions real DOM rows at
 * these coordinates, with one full-height `<svg>` underlay for the ribbons
 * themselves (DOM over SVG, the pond's own layering).
 *
 * Also holds two small pure helpers for "the water" — the collapsible
 * Now/Changes/Writes sections under a selected collection: `relativeDayTime`
 * (Today/Yesterday/"Mon D" + HH:MM, for commit and write-event timestamps)
 * and `classifyDiffLine` (which of add/del/hunk/meta/ctx a unified-diff line
 * is, so CreekView can tint it without re-deriving the rule in JSX).
 *
 * Prompt this was built against: "the terrain map is the creek — code files on
 * the left bank, data collections on the right bank, ribbons of flow between
 * them. Tap anything and the rest dims, never hides; every call is clickable
 * through to the real source line." The water sections were added after, on:
 * "when a collection is selected, show what the data IS and WAS, not just
 * that it flows — current contents, git history with diffs, the write
 * journal — all lazy, collapsed by default."
 *
 * Extended for: "creek Today mode — only the past day, ribbons more opaque by
 * recency, rolling/near-real-time; and independent writes/reads layer toggles
 * so reads can be viewed alone on their own scale." That added: `freshnessFactor`
 * (exp decay of a collection's write-recency, floored so nothing ever fully
 * disappears), `collectionRowOpacity` (a right-bank row's opacity: dimmed wins
 * outright, otherwise freshness), `toggleLayer` (the Writes/Reads chips'
 * never-both-off rule), `sortMetricFor` (which count a bank sorts by, given
 * which layers are on), and `ribbonRenderWidth` (a ribbon's stroke width for
 * however it's currently drawn — write scale, read hairline, or read-owns-the-
 * scale). `ribbonOpacity` and `buildRibbons` grew to carry freshness and a
 * read-side log-ramp weight respectively.
 *
 * TWO MODES, TWO MEANINGS — the "traffic mode" section at the bottom. The page
 * was drawing one picture that meant two different things at once, and only the
 * time window changed between them, so a collection nothing had touched all day
 * still showed a fat write ribbon and read as busy. Now the mode picks what a
 * ribbon MEANS:
 *
 *   WIRING (the 14-day map, everything above) — left bank is source files,
 *   ribbon width is how many `store.write(...)` CALL SITES exist. It says what
 *   the code CAN do. Nothing here is about a particular day.
 *
 *   TRAFFIC (today) — ribbon width is writes that actually HAPPENED. That
 *   forces a different left bank: the telemetry records the calling PROCESS
 *   (`gunicorn`, `run_dispatcher`, `turn_host`), never the source line, so a
 *   truthful traffic view cannot keep files on the left. `aggregateCallers`
 *   rebuilds the left bank out of `collection.callers[]` — real names, real
 *   counts, real window — and `buildTrafficRibbons` draws caller→collection
 *   with those counts. Collections nothing touched drop out entirely
 *   (`activeCollections`), counted aloud rather than silently hidden.
 *
 * The other half of that fix is `writeState`, which replaces a single
 * continuous fade that couldn't tell "quiet" apart from "we don't know."
 */

import type { CreekCall, CreekCaller, CreekCollection, CreekFile } from './api';

// --- geometry constants ------------------------------------------------------
// Fixed, not measured: CreekView positions every row and ribbon endpoint from
// these same numbers, so the drawing and the arithmetic can never disagree.

/** A row's tap height — the house 40px target. */
export const ROW_H = 40;
/** Breathing room between two rows in the same group. */
export const ROW_GAP = 2;
/** A small-caps group header ("server", "sql", ...). */
export const HEADER_H = 24;
/** Extra room between one group and the next. */
export const GROUP_GAP = 12;
/** Room above the first header. */
export const TOP_PAD = 8;

/** Left bank width — file rows. */
export const LEFT_W = 250;
/** The room between the banks the ribbons bulge through. */
export const MID_W = 150;
/** Right bank width — collection rows. */
export const RIGHT_W = 250;
/** Total stage width — left bank + ribbon room + right bank. */
export const STAGE_W = LEFT_W + MID_W + RIGHT_W;
/** X where a ribbon leaves the left bank (its right edge). */
export const LEFT_X = LEFT_W;
/** X where a ribbon arrives at the right bank (its left edge). */
export const RIGHT_X = LEFT_W + MID_W;

/** A write ribbon's stroke width at weight 0 / weight 1. Reads never scale —
 * they're a fixed hairline (`READ_STROKE`) on purpose, a different axis. */
export const MIN_STROKE = 1.5;
export const MAX_STROKE = 12;
export const READ_STROKE = 1;

/** Base opacities — writes carry the ink, reads are context, and a dimmed
 * ribbon stays drawn rather than disappearing (the pond's own dot floor). */
export const WRITE_BASE_OPACITY = 0.35;
export const READ_BASE_OPACITY = 0.12;
export const DIM_OPACITY = 0.16;
export const LIT_WRITE_OPACITY = 1;
export const LIT_READ_OPACITY = 0.5;

/** Today mode's recency fade: roughly how many hours until a write's
 * freshness has decayed by half, and the floor it never decays past (the
 * same "never fully invisible" idiom as the opacity floors above). */
export const FRESHNESS_HALF_LIFE_HOURS = 6;
export const FRESHNESS_FLOOR = 0.25;

/**
 * How recently a collection's write journal actually saw it, 0..1 — Today
 * mode's per-collection recency fade. Exponential decay against
 * `FRESHNESS_HALF_LIFE_HOURS` (so `hoursSince = 6` reads about half as fresh
 * as `hoursSince = 0`), floored at `FRESHNESS_FLOOR` so a collection that's
 * simply gone quiet for a while never fades to nothing — that would read as
 * "this doesn't exist," which isn't what's true. `lastWrite === null` (the
 * journal has never seen a write for this collection) reads as maximally
 * stale — the same floor, not zero, since "no journal entry yet" isn't the
 * same claim as "definitely nothing happened." An unparseable timestamp gets
 * the same treatment rather than throwing. `now` is injectable for tests.
 */
export function freshnessFactor(lastWrite: string | null, now: Date = new Date()): number {
  if (lastWrite === null) return FRESHNESS_FLOOR;
  const d = new Date(lastWrite);
  if (Number.isNaN(d.getTime())) return FRESHNESS_FLOOR;
  const hoursSince = Math.max(0, (now.getTime() - d.getTime()) / 3_600_000);
  return Math.max(FRESHNESS_FLOOR, Math.exp(-hoursSince / FRESHNESS_HALF_LIFE_HOURS));
}

// --- rows & banks -------------------------------------------------------------

/** The left bank's groups, in the order she reads them. */
export const FILE_AREAS: { key: CreekFile['area']; label: string }[] = [
  { key: 'server', label: 'server' },
  { key: 'routes', label: 'routes' },
  { key: 'scripts', label: 'scripts' },
  { key: 'tools', label: 'tools' },
];

/** The right bank's groups. */
export const COLLECTION_BACKINGS: { key: CreekCollection['backing']; label: string }[] = [
  { key: 'sql', label: 'sql' },
  { key: 'json', label: 'json' },
];

/** How many of a file's calls are writes (verb `write` or `mutate`) — what the
 * left bank sorts by, heaviest writer first. Reads exist too, but writes are
 * the story a bank is ranked on. */
export function fileWrites(file: CreekFile): number {
  return file.calls.filter((c) => c.verb === 'write' || c.verb === 'mutate').length;
}

/** How many of a file's calls are plain reads. */
export function fileReads(file: CreekFile): number {
  return file.calls.filter((c) => c.verb === 'read').length;
}

export interface RowLayout<T> {
  key: string;
  /** Top of the row's box. */
  y: number;
  /** Vertical centre — where a ribbon actually lands. */
  cy: number;
  item: T;
}

export interface GroupHeader {
  key: string;
  label: string;
  y: number;
}

export interface BankLayout<T> {
  rows: RowLayout<T>[];
  headers: GroupHeader[];
  /** Total height the bank needs — the taller bank sets the canvas height. */
  height: number;
}

/** Stack a bank's groups top to bottom: header, then its rows at ROW_H each,
 * skipping empty groups entirely rather than drawing a header over nothing. */
function layoutGroups<T>(
  groups: { key: string; label: string; items: T[] }[],
  keyOf: (item: T) => string,
): BankLayout<T> {
  const rows: RowLayout<T>[] = [];
  const headers: GroupHeader[] = [];
  let y = TOP_PAD;
  for (const g of groups) {
    if (g.items.length === 0) continue;
    headers.push({ key: g.key, label: g.label, y });
    y += HEADER_H;
    for (const item of g.items) {
      rows.push({ key: keyOf(item), y, cy: y + ROW_H / 2, item });
      y += ROW_H + ROW_GAP;
    }
    y += GROUP_GAP;
  }
  return { rows, headers, height: Math.max(y, TOP_PAD) };
}

/** Which count a bank is currently ranked by. */
export type CreekSortMetric = 'writes' | 'reads';

/**
 * Which count a bank sorts by, given the two layer chips — follows what's
 * actually visible rather than a fixed writes-first rule: writes drawn
 * (Writes chip on, whatever Reads is) → writes desc, same as always. Writes
 * hidden (reads-only mode) → reads desc, since reads are the whole story
 * then. Falls back to `'writes'` if somehow both chips were off (shouldn't
 * happen — `toggleLayer` guarantees at least one stays on).
 */
export function sortMetricFor(writesOn: boolean, readsOn: boolean): CreekSortMetric {
  if (writesOn) return 'writes';
  return readsOn ? 'reads' : 'writes';
}

/** The left bank: files grouped by area, ranked by `metric` within each
 * group (writes by default), ties broken by path so the order is stable
 * between renders. */
export function layoutFiles(
  files: readonly CreekFile[],
  metric: CreekSortMetric = 'writes',
): BankLayout<CreekFile> {
  const rank = metric === 'reads' ? fileReads : fileWrites;
  const groups = FILE_AREAS.map((a) => ({
    key: a.key,
    label: a.label,
    items: [...files]
      .filter((f) => f.area === a.key)
      .sort((x, y) => rank(y) - rank(x) || x.path.localeCompare(y.path)),
  }));
  return layoutGroups(groups, (f) => f.path);
}

/** The right bank: collections grouped by backing, ranked by `metric`
 * (writes by default). */
export function layoutCollections(
  collections: readonly CreekCollection[],
  metric: CreekSortMetric = 'writes',
): BankLayout<CreekCollection> {
  const rank = (c: CreekCollection) => (metric === 'reads' ? c.reads : c.writes);
  const groups = COLLECTION_BACKINGS.map((b) => ({
    key: b.key,
    label: b.label,
    items: [...collections]
      .filter((c) => c.backing === b.key)
      .sort((x, y) => rank(y) - rank(x) || x.id.localeCompare(y.id)),
  }));
  return layoutGroups(groups, (c) => c.id);
}

// --- ribbon width, the pond's own log-ramp-with-floor idiom -------------------

/**
 * How wide a WRITE ribbon draws, 0..1, from its write count against the
 * heaviest flow on the page.
 *
 * Same shape as the pond's `writeWeight`: logarithmic (a handful of flows
 * dwarf the rest, and a linear ramp would flatten everything under them to
 * nothing), floored at 0.35 so a flow that exists is never invisible — fading
 * a real write to nothing to make a busier one look busier is the drawing
 * lying about what it knows.
 */
export function ribbonWeight(writes: number, cap: number): number {
  const n = Math.max(0, writes || 0);
  if (n <= 0) return 0;
  const safeCap = Math.max(n, cap, 2);
  return Math.min(1, 0.35 + (Math.log(n + 1) / Math.log(safeCap + 1)) * 0.65);
}

/** A ribbon weight (0..1) → an actual stroke width in pixels. */
export function ribbonStrokeWidth(weight: number): number {
  return MIN_STROKE + weight * (MAX_STROKE - MIN_STROKE);
}

/**
 * A ribbon's stroke width for however it's currently drawn. Write ribbons
 * always use the write log-ramp (`weight` against the write cap). Read
 * ribbons are normally a fixed hairline (`READ_STROKE`) — context, not the
 * story — but when the Writes chip is off (reads-only mode) reads BECOME the
 * story and get their own log-ramp width, computed from `weight` the exact
 * same way writes are (`readsOwnScale` true). The two still never share a
 * scale even then: `buildRibbons` computes read `weight` against a read-only
 * cap, never the write cap.
 */
export function ribbonRenderWidth(
  kind: 'read' | 'write',
  weight: number,
  readsOwnScale: boolean,
): number {
  if (kind === 'write') return ribbonStrokeWidth(weight);
  return readsOwnScale ? ribbonStrokeWidth(weight) : READ_STROKE;
}

/**
 * A ribbon's opacity for its current state: dimmed (something else is lit) —
 * always wins outright, full stop — lit (this is the selection's own flow),
 * or resting (nothing selected). Reads and writes are held to different
 * ceilings even when both are lit — writes carry the ink, reads stay
 * context. `freshness` (0..1, default 1) is Today mode's recency fade —
 * CreekView passes a real value only for WRITE ribbons while in Today mode;
 * reads have no per-event timestamps to fade by, so they always get 1.
 */
export function ribbonOpacity(
  kind: 'read' | 'write',
  dimmed: boolean,
  lit: boolean,
  freshness: number = 1,
): number {
  if (dimmed) return DIM_OPACITY;
  const base = lit
    ? kind === 'write'
      ? LIT_WRITE_OPACITY
      : LIT_READ_OPACITY
    : kind === 'write'
      ? WRITE_BASE_OPACITY
      : READ_BASE_OPACITY;
  return base * freshness;
}

/**
 * A right-bank collection row's opacity in Today mode: dimmed (a selection
 * elsewhere) always wins outright, same rule as ribbons; otherwise the row
 * fades by `freshness` (see `freshnessFactor`). In 14-day mode CreekView
 * always passes `freshness = 1`, which collapses this back to the old
 * dimmed/full-opacity behavior — left-bank file rows never get this, since
 * the payload carries no per-file write timestamp to fade by.
 */
export function collectionRowOpacity(dimmed: boolean, freshness: number): number {
  return dimmed ? DIM_OPACITY : freshness;
}

// --- ribbon paths ---------------------------------------------------------

/** A cubic-bezier "S" from one bank's row edge to the other's — the sankey-ish
 * ribbon curve. Control points sit at the horizontal midpoint of the two ends
 * so the curve leaves and arrives level, whatever the vertical drop. */
export function ribbonPathD(x1: number, y1: number, x2: number, y2: number): string {
  const midX = x1 + (x2 - x1) / 2;
  return (
    `M ${x1.toFixed(1)},${y1.toFixed(1)} ` +
    `C ${midX.toFixed(1)},${y1.toFixed(1)} ${midX.toFixed(1)},${y2.toFixed(1)} ` +
    `${x2.toFixed(1)},${y2.toFixed(1)}`
  );
}

export interface CreekRibbon {
  /** The left-bank row this ribbon leaves from — a file path in wiring mode, a
   * caller name in traffic mode. Named `source` rather than `file` because
   * both banks are real: in traffic mode no file is (or could honestly be)
   * named, since telemetry only knows the calling process. */
  source: string;
  collection: string;
  kind: 'read' | 'write';
  /** In wiring mode, how many calls of this kind this file makes to this
   * collection (call sites in source). In traffic mode, how many actually
   * happened in the window. */
  count: number;
  /** 0..1, meaningful for `write` ribbons only — reads are a fixed hairline. */
  weight: number;
  d: string;
}

/**
 * Every ribbon the creek draws: one file+collection pair can carry BOTH a
 * write ribbon and a read ribbon (two different calls, two different lines),
 * since they never share a width scale and must be styled independently.
 *
 * Silently skips a call whose collection isn't in the payload's own
 * `collections` list (nothing to draw a ribbon TO) — that's not the same as
 * `unresolved`, which the server already separates out for calls it couldn't
 * even resolve to a name.
 */
export function buildRibbons(
  files: readonly CreekFile[],
  fileBank: BankLayout<CreekFile>,
  collectionBank: BankLayout<CreekCollection>,
  leftX: number = LEFT_X,
  rightX: number = RIGHT_X,
): CreekRibbon[] {
  const fileY = new Map(fileBank.rows.map((r) => [r.key, r.cy]));
  const colY = new Map(collectionBank.rows.map((r) => [r.key, r.cy]));

  interface Agg {
    file: string;
    collection: string;
    writes: number;
    reads: number;
  }
  const agg = new Map<string, Agg>();
  for (const f of files) {
    for (const c of f.calls) {
      const key = `${f.path} ${c.collection}`;
      let e = agg.get(key);
      if (!e) {
        e = { file: f.path, collection: c.collection, writes: 0, reads: 0 };
        agg.set(key, e);
      }
      if (c.verb === 'read') e.reads += 1;
      else e.writes += 1;
    }
  }

  // The log ramp's ceiling for each kind: the heaviest single file→collection
  // flow of that kind on the page, so the busiest ribbon fills its scale
  // rather than an arbitrary fixed cap flattening everything below a much
  // smaller real maximum. Writes and reads get SEPARATE caps — computing
  // read weight here (even though it's only drawn wide in reads-only mode)
  // means it's never derived against the write cap by accident.
  let writeCap = 1;
  let readCap = 1;
  for (const e of agg.values()) {
    if (e.writes > writeCap) writeCap = e.writes;
    if (e.reads > readCap) readCap = e.reads;
  }

  const out: CreekRibbon[] = [];
  for (const e of agg.values()) {
    const y1 = fileY.get(e.file);
    const y2 = colY.get(e.collection);
    if (y1 === undefined || y2 === undefined) continue;
    const d = ribbonPathD(leftX, y1, rightX, y2);
    if (e.writes > 0) {
      out.push({
        source: e.file,
        collection: e.collection,
        kind: 'write',
        count: e.writes,
        weight: ribbonWeight(e.writes, writeCap),
        d,
      });
    }
    if (e.reads > 0) {
      out.push({
        source: e.file,
        collection: e.collection,
        kind: 'read',
        count: e.reads,
        weight: ribbonWeight(e.reads, readCap),
        d,
      });
    }
  }
  return out;
}

/** The Writes/Reads layer chips, applied — each kind draws only while its
 * own chip is on. CreekView never lets both go off at once (`toggleLayer`),
 * but this function itself doesn't assume that — pass both false and
 * nothing draws, honestly. */
export function visibleRibbons(
  ribbons: readonly CreekRibbon[],
  writesOn: boolean,
  readsOn: boolean,
): CreekRibbon[] {
  return ribbons.filter((r) => (r.kind === 'write' ? writesOn : readsOn));
}

/**
 * Toggling one of the Writes/Reads layer chips, with the "never a blank
 * creek" rule: turning off the last lit chip turns the OTHER one on instead
 * of leaving both dark, rather than just flipping the one that was tapped.
 */
export function toggleLayer(
  writesOn: boolean,
  readsOn: boolean,
  layer: 'writes' | 'reads',
): { writesOn: boolean; readsOn: boolean } {
  if (layer === 'writes') {
    const next = !writesOn;
    if (!next && !readsOn) return { writesOn: false, readsOn: true };
    return { writesOn: next, readsOn };
  }
  const next = !readsOn;
  if (!next && !writesOn) return { writesOn: true, readsOn: false };
  return { writesOn, readsOn: next };
}

// --- selection: emphasis, never a filter --------------------------------------

export type CreekSelection =
  | { kind: 'file'; path: string }
  | { kind: 'caller'; name: string }
  | { kind: 'collection'; id: string };

/** The sets a selection implies: which collections the selected left-bank row
 * touches, and which left-bank rows touch a selected collection. Precomputed
 * once per selection so row/ribbon dimming is O(1) rather than re-scanning
 * calls per row drawn. `files` is filled in wiring mode and `callers` in
 * traffic mode — the mode only ever draws one of the two banks, so the other
 * set stays empty rather than being faked. */
export interface SelectionSets {
  collections: ReadonlySet<string>;
  files: ReadonlySet<string>;
  callers: ReadonlySet<string>;
}

export const EMPTY_SELECTION_SETS: SelectionSets = {
  collections: new Set(),
  files: new Set(),
  callers: new Set(),
};

export function selectionSets(
  sel: CreekSelection | null,
  files: readonly CreekFile[],
): SelectionSets {
  if (!sel) return EMPTY_SELECTION_SETS;
  if (sel.kind === 'caller') return EMPTY_SELECTION_SETS; // not this mode's bank
  if (sel.kind === 'file') {
    const file = files.find((f) => f.path === sel.path);
    return {
      collections: new Set(file ? file.calls.map((c) => c.collection) : []),
      files: new Set([sel.path]),
      callers: new Set(),
    };
  }
  const touching = new Set<string>();
  for (const f of files) {
    if (f.calls.some((c) => c.collection === sel.id)) touching.add(f.path);
  }
  return { collections: new Set([sel.id]), files: touching, callers: new Set() };
}

/** Is this file row dimmed — something's selected and it isn't this file, nor
 * a partner of what is. */
export function fileDimmed(sel: CreekSelection | null, sets: SelectionSets, path: string): boolean {
  return sel !== null && !sets.files.has(path);
}

/** Is this collection row dimmed. */
export function collectionDimmed(
  sel: CreekSelection | null,
  sets: SelectionSets,
  id: string,
): boolean {
  return sel !== null && !sets.collections.has(id);
}

/** Is this caller row dimmed — traffic mode's left bank, same rule as
 * `fileDimmed` against the other bank. */
export function callerDimmed(
  sel: CreekSelection | null,
  sets: SelectionSets,
  name: string,
): boolean {
  return sel !== null && !sets.callers.has(name);
}

/** Is this exact ribbon (one left-bank row, one collection) part of the lit
 * selection. `source` is a file path in wiring mode, a caller name in
 * traffic mode — whichever bank is currently drawn. */
export function ribbonDimmed(
  sel: CreekSelection | null,
  source: string,
  collectionId: string,
): boolean {
  if (!sel) return false;
  if (sel.kind === 'file') return sel.path !== source;
  if (sel.kind === 'caller') return sel.name !== source;
  return sel.id !== collectionId;
}

// --- detail panel helpers ------------------------------------------------------

/** A file's calls, earliest line first — the order they read in the source. */
export function sortedCalls(file: CreekFile): CreekCall[] {
  return [...file.calls].sort((a, b) => a.line - b.line);
}

/** A collection's callers, busiest first — "who actually moved it" wants the
 * heaviest hand named first, not an arbitrary payload order. */
export function sortedCallers(collection: CreekCollection): CreekCaller[] {
  return [...collection.callers].sort(
    (a, b) => b.writes + b.reads - (a.writes + a.reads) || a.name.localeCompare(b.name),
  );
}

/** The files (by path) that carry at least one call into this collection —
 * what the collection detail panel lists as "files that touch it". */
export function filesTouching(files: readonly CreekFile[], collectionId: string): CreekFile[] {
  return files.filter((f) => f.calls.some((c) => c.collection === collectionId));
}

/** The `/code` deep link for one call — repo is always `skeleton` (the creek
 * only maps this repo's own files), lines is a single-line range since a call
 * is one statement. The `/code` page (built in parallel) reads `lines` to
 * highlight and scroll; this only ever emits the URL. */
export function codeHref(path: string, line: number): string {
  const params = new URLSearchParams({
    repo: 'skeleton',
    path,
    lines: `${line}-${line}`,
  });
  return `/code?${params.toString()}`;
}

// --- traffic mode: what actually moved, and who moved it ----------------------
// Everything above this line is WIRING — the static picture of what the code
// can do. Everything below is TRAFFIC — what happened in the window. They are
// deliberately separate: no function here derives a width, a row, or a fade
// from a call site, and nothing above reads a telemetry count.

/** A collection nothing touched in the window still draws a row, at this
 * opacity — visibly asleep, but present and readable. Not the freshness floor:
 * "nothing happened" is a fact worth stating, not a faded guess. */
export const QUIET_OPACITY = 0.3;

/**
 * What a collection's write activity honestly is, in the window.
 *
 * The distinction that matters, and the whole reason a single 0..1 fade wasn't
 * enough: the COUNTS come from store.py's own op counters (always on, so a
 * zero really means zero), but the TIMESTAMPS come from the write journal,
 * which is younger than the counters and doesn't cover typed stores at all. So
 * "nothing wrote this" and "something wrote this but the journal can't say
 * when" are different claims, and fading both to the same grey said neither.
 *
 *   'quiet'    — zero writes in the window. Known, not guessed.
 *   'timeless' — real writes, but no journal timestamp to place them at.
 *   'moved'    — real writes with a real timestamp; fade by recency.
 */
export type WriteState = 'moved' | 'timeless' | 'quiet';

export function writeState(writes: number, lastWrite: string | null): WriteState {
  if (!(writes > 0)) return 'quiet';
  return lastWrite === null ? 'timeless' : 'moved';
}

/**
 * A right-bank row's opacity in traffic mode, by state. Dimmed (a selection
 * elsewhere) still wins outright, same rule as everywhere else. A 'timeless'
 * row draws at FULL opacity on purpose — it definitely moved, so fading it
 * would understate a fact we actually know; its unknown-ness is said in words
 * on the row instead. Only 'moved' fades, and only by real recency.
 */
export function trafficRowOpacity(
  state: WriteState,
  dimmed: boolean,
  freshness: number,
): number {
  if (dimmed) return DIM_OPACITY;
  if (state === 'quiet') return QUIET_OPACITY;
  if (state === 'timeless') return 1;
  return Math.max(FRESHNESS_FLOOR, freshness);
}

/** One process that actually touched the vault in the window, with its
 * per-collection breakdown — traffic mode's left-bank row. */
export interface TrafficCaller {
  name: string;
  /** Its source file when the server could name one (`scripts/<name>.py`),
   * null otherwise — gunicorn and the Rust binaries have no single file. */
  file: string | null;
  reads: number;
  writes: number;
  touches: { collection: string; reads: number; writes: number }[];
}

/**
 * Traffic mode's left bank, inverted out of the payload: the API reports
 * callers nested under each collection, and this regroups them into one row
 * per caller with its own per-collection breakdown. A caller's totals are the
 * sum of its touches — never a separate number that could drift from them.
 */
export function aggregateCallers(collections: readonly CreekCollection[]): TrafficCaller[] {
  const byName = new Map<string, TrafficCaller>();
  for (const c of collections) {
    for (const caller of c.callers) {
      let e = byName.get(caller.name);
      if (!e) {
        e = { name: caller.name, file: caller.file, reads: 0, writes: 0, touches: [] };
        byName.set(caller.name, e);
      }
      // First non-null file wins — a caller reported with a file against one
      // collection and without against another is still the same process.
      if (e.file === null && caller.file !== null) e.file = caller.file;
      e.reads += caller.reads;
      e.writes += caller.writes;
      e.touches.push({ collection: c.id, reads: caller.reads, writes: caller.writes });
    }
  }
  return [...byName.values()];
}

/** The collections that actually saw traffic in the window — traffic mode's
 * right bank. Quiet ones are dropped from the DRAWING (a ribbonless row in a
 * flow map is noise), and CreekView says how many were dropped rather than
 * letting them vanish silently. */
export function activeCollections(
  collections: readonly CreekCollection[],
): CreekCollection[] {
  return collections.filter((c) => c.reads > 0 || c.writes > 0);
}

/** The two groups traffic mode's left bank splits into — who wrote something,
 * and who only ever looked. Worth separating: the heaviest reader on the page
 * is usually the web server, and it would otherwise sit at the top of a bank
 * that's meant to answer "what changed my data". */
export const CALLER_ROLES: { key: 'writers' | 'readers'; label: string }[] = [
  { key: 'writers', label: 'wrote' },
  { key: 'readers', label: 'read only' },
];

/** The left bank in traffic mode: callers grouped by whether they wrote,
 * ranked by `metric` within each group, ties broken by name so the order is
 * stable between polls. */
export function layoutCallers(
  callers: readonly TrafficCaller[],
  metric: CreekSortMetric = 'writes',
): BankLayout<TrafficCaller> {
  const rank = (c: TrafficCaller) => (metric === 'reads' ? c.reads : c.writes);
  const groups = CALLER_ROLES.map((r) => ({
    key: r.key,
    label: r.label,
    items: [...callers]
      .filter((c) => (r.key === 'writers' ? c.writes > 0 : c.writes === 0))
      .sort((x, y) => rank(y) - rank(x) || x.name.localeCompare(y.name)),
  }));
  return layoutGroups(groups, (c) => c.name);
}

/**
 * Traffic mode's ribbons: caller → collection, one per kind, width from the
 * counts that actually happened. Structurally the same log-ramp-with-floor as
 * `buildRibbons` — including separate write and read caps, so the two never
 * share an axis — but every number feeding it is measured rather than counted
 * out of the source.
 *
 * Skips a touch whose collection isn't on the drawn bank (a quiet collection
 * can't be, by definition) and one with no counts at all, so a caller listed
 * against a collection it didn't move this window draws nothing.
 */
export function buildTrafficRibbons(
  callers: readonly TrafficCaller[],
  callerBank: BankLayout<TrafficCaller>,
  collectionBank: BankLayout<CreekCollection>,
  leftX: number = LEFT_X,
  rightX: number = RIGHT_X,
): CreekRibbon[] {
  const callerY = new Map(callerBank.rows.map((r) => [r.key, r.cy]));
  const colY = new Map(collectionBank.rows.map((r) => [r.key, r.cy]));

  let writeCap = 1;
  let readCap = 1;
  for (const c of callers) {
    for (const t of c.touches) {
      if (!colY.has(t.collection)) continue;
      if (t.writes > writeCap) writeCap = t.writes;
      if (t.reads > readCap) readCap = t.reads;
    }
  }

  const out: CreekRibbon[] = [];
  for (const c of callers) {
    const y1 = callerY.get(c.name);
    if (y1 === undefined) continue;
    for (const t of c.touches) {
      const y2 = colY.get(t.collection);
      if (y2 === undefined) continue;
      const d = ribbonPathD(leftX, y1, rightX, y2);
      if (t.writes > 0) {
        out.push({
          source: c.name,
          collection: t.collection,
          kind: 'write',
          count: t.writes,
          weight: ribbonWeight(t.writes, writeCap),
          d,
        });
      }
      if (t.reads > 0) {
        out.push({
          source: c.name,
          collection: t.collection,
          kind: 'read',
          count: t.reads,
          weight: ribbonWeight(t.reads, readCap),
          d,
        });
      }
    }
  }
  return out;
}

/** Traffic mode's counterpart to `selectionSets`: a lit caller lights the
 * collections it moved; a lit collection lights the callers that moved it.
 * Only touches with real counts count as a link — the same rule
 * `buildTrafficRibbons` draws by, so lighting and ribbons can't disagree. */
export function trafficSelectionSets(
  sel: CreekSelection | null,
  callers: readonly TrafficCaller[],
): SelectionSets {
  if (!sel) return EMPTY_SELECTION_SETS;
  const moved = (t: { reads: number; writes: number }) => t.reads > 0 || t.writes > 0;
  if (sel.kind === 'caller') {
    const c = callers.find((x) => x.name === sel.name);
    return {
      collections: new Set(c ? c.touches.filter(moved).map((t) => t.collection) : []),
      files: new Set(),
      callers: new Set([sel.name]),
    };
  }
  if (sel.kind === 'file') return EMPTY_SELECTION_SETS; // not this mode's bank
  const touching = new Set<string>();
  for (const c of callers) {
    if (c.touches.some((t) => t.collection === sel.id && moved(t))) touching.add(c.name);
  }
  return { collections: new Set([sel.id]), files: new Set(), callers: touching };
}

/** A caller's own touches, heaviest first — what the caller detail panel
 * lists, and the same "busiest hand first" order `sortedCallers` uses. */
export function sortedTouches(caller: TrafficCaller): TrafficCaller['touches'] {
  return [...caller.touches]
    .filter((t) => t.reads > 0 || t.writes > 0)
    .sort((a, b) => b.writes - a.writes || b.reads - a.reads || a.collection.localeCompare(b.collection));
}

/** The short label on a traffic-mode right-bank row's right edge: the count
 * that's being ranked on, or the plain word "quiet" when nothing happened —
 * a number and a state read differently, and "0" next to a faded row is
 * exactly the ambiguity this mode exists to remove. */
export function trafficCountLabel(
  collection: CreekCollection,
  metric: CreekSortMetric,
): string {
  const n = metric === 'reads' ? collection.reads : collection.writes;
  if (n <= 0) return 'quiet';
  return n.toLocaleString();
}

// --- the water: timestamps and diff lines --------------------------------

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** An ISO timestamp → "Today 14:32" / "Yesterday 09:15" / "Aug 18 09:15" —
 * the commit/write-event row label. Compares calendar days (not a 24h
 * window), so a commit at 00:05 today reads "Today" even minutes after
 * midnight. `now` is injectable for tests; defaults to the real clock. An
 * unparseable timestamp is returned as-is rather than thrown on — a bad date
 * from the server shouldn't blank a whole row. */
export function relativeDayTime(ts: string, now: Date = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()} ${time}`;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/** What kind of unified-diff line this is, for CreekView's per-line tinting.
 * Order matters: a `+++`/`---` file header starts with the same character as
 * an added/removed line, so header lines (and `diff --git` / `index …`) must
 * be caught as `meta` BEFORE the single-character add/del check, or every
 * diff would render its own file headers as a bogus add+del pair. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
