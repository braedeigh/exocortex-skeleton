import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  useCreek,
  useCollectionDiff,
  useCollectionHistory,
  useCollectionNow,
  useCollectionWrites,
} from './api';
import type { CreekCollection, CreekDiff, CreekFile, CreekPatchOp } from './api';
import {
  LEFT_W,
  RIGHT_W,
  RIGHT_X,
  ROW_H,
  STAGE_W,
  activeCollections,
  aggregateCallers,
  buildRibbons,
  buildTrafficRibbons,
  callerDimmed,
  classifyDiffLine,
  codeHref,
  collectionDimmed,
  collectionRowOpacity,
  fileDimmed,
  freshnessAt,
  halfLifeForWindow,
  fileReads,
  fileWrites,
  filesTouching,
  layoutCallers,
  layoutCollections,
  layoutFiles,
  relativeDay,
  relativeDayTime,
  ribbonDimmed,
  ribbonOpacity,
  ribbonRenderWidth,
  selectionSets,
  sortMetricFor,
  sortedCallers,
  sortedCalls,
  sortedTouches,
  toggleLayer,
  trafficCountLabel,
  trafficRowOpacity,
  trafficSelectionSets,
  visibleRibbons,
  writeState,
  type CreekSelection,
  type DiffLineKind,
  type TrafficCaller,
} from './creekMath';
import styles from './CreekView.module.css';

/**
 * CreekView — data flow drawn as a place: code files on the left bank, vault
 * collections on the right bank, ribbons of flow between them.
 *
 * This is the OTHER half of the terrain map's own name for itself — "the
 * creek" was always the map's word for data moving across the seam between
 * code and vault, and this page finally draws that literally instead of as a
 * metaphor. Reads GET /api/creek (routes/creek.py, built in parallel — see
 * api.ts for the exact contract this was coded against) and writes nothing;
 * the creek is read-only, a map of flow that already happened over the last
 * `days` window.
 *
 * All positioning arithmetic — where a row sits, how wide and how lit a
 * ribbon draws — lives in creekMath.ts and is tested there. This file only
 * places real DOM rows at those computed coordinates (DOM over SVG, the
 * pond's own layering) with one full-height `<svg>` underlay carrying the
 * ribbons, and handles what's selected.
 *
 * SELECTION is emphasis, never a filter, same grammar as the pond's lit
 * thread: tap a file or a collection and its own flow goes full ink while
 * everything else dims to ~0.16 but stays drawn — nothing hides. Tap again,
 * or Esc, clears it. Kept in one useState, persisted to localStorage
 * (`creek-view`) the way the pond persists `pond-view`.
 *
 * "THE WATER": when a collection is selected, three more sections sit below
 * its backing/files/callers — Now (current contents), Changes (git history +
 * inline diffs), Writes (the capture journal). Each is a real ~40px chevron
 * button (RetiredCountersCard's own row-toggle idiom), collapsed by default,
 * fetching nothing until opened (api.ts's four hooks are each `enabled` only
 * while its section is open). Open/closed state lives in the same
 * `creek-view` localStorage blob as selection/mode/layers — one section's
 * state is shared across whichever collection happens to be selected, the
 * same way the layer chips are shared rather than per-file. Picking a commit
 * inside Changes opens its diff inline directly under that row; picking a
 * different collection or closing Changes resets which commit (if any) is
 * open.
 *
 * MODE: a two-position control, and it switches WHAT A RIBBON MEANS, not just
 * the time window — the two are genuinely different pictures:
 *
 *   "Wiring" (`?days=14`) — the original map. Left bank is source files,
 *   ribbon width is call sites. What the code CAN do.
 *
 *   "Traffic" (`?days=` the chosen window — 1, 7 or 30; the today window is
 *   polled every 60s, the longer ones aren't, since a 30-day sum doesn't move
 *   in a minute. React-query's own `refetchIntervalInBackground: false`
 *   default stops that poll in a backgrounded tab, matching the house battery
 *   contract for free) — ribbon width is writes that actually happened over
 *   that window. The left bank becomes CALLERS
 *   (`creekMath.aggregateCallers`), because telemetry knows the calling
 *   process and never the source line; keeping files there would have been
 *   drawing an attribution nobody measured. Collections with no traffic drop
 *   off the drawing (`activeCollections`) and are counted aloud in the
 *   subtitle instead.
 *
 * In traffic mode, right-bank rows carry a four-way state
 * (`creekMath.writeState` → `trafficRowOpacity`) rather than one continuous
 * fade, ordered by how much is actually known: an exact journal timestamp and
 * a counter-derived DAY both fade by recency (`creekMath.freshnessAt` prefers
 * the exact one), a write with no "when" at all draws full with the unknown
 * said in words, and genuinely quiet draws at `QUIET_OPACITY`. The fade's
 * half-life scales to the window (`creekMath.halfLifeForWindow`) so a month's
 * worth of writes doesn't collapse onto the floor together. Write ribbons fade
 * the same way; read ribbons never do — reads are running totals with no
 * per-event timestamp, and the legend says so rather than implying a freshness
 * they don't have.
 *
 * LAYERS: the Writes and Reads chips are independent — each can be off on
 * its own, but never both (`creekMath.toggleLayer`: killing the last lit
 * chip turns the other one on, so the creek is never blank). Reads-only mode
 * makes reads the story: they get their own log-ramp width scale (never the
 * write scale — `creekMath.ribbonRenderWidth`), draw in `--text-secondary`
 * (never `--accent`, which writes own alone), and the banks re-sort by reads
 * instead of writes (`creekMath.sortMetricFor`).
 *
 * Prompt this was built against: "the terrain map is the creek — code files
 * on the left bank, data collections on the right bank, ribbons of flow
 * between them. Tap anything and the rest dims, never hides; every call is
 * clickable through to the real source line." The water sections were added
 * after, on: "when a collection is selected, show what the data IS and WAS,
 * not just that it flows — current contents, git history with diffs, the
 * write journal — all lazy, collapsed by default." Mode + layers were added
 * on: "creek Today mode — only the past day, ribbons more opaque by recency,
 * rolling/near-real-time; and independent writes/reads layer toggles so
 * reads can be viewed alone on their own scale." Wiring/Traffic replaced that
 * Today mode on: "the Today page doesn't make sense — why would it be writing
 * to budget? Make it clearer": the ribbons were a static call-site scan that
 * didn't change between modes, so a collection nothing had touched all day
 * still drew a fat write ribbon. The 1/7/30 window followed on "can we scrape
 * it from GitHub?" — no scraping needed: `feature_usage` already held ~33 days
 * of per-caller counts, so the longer windows were a parameter, not a
 * backfill. `last_write_day` came with them, since over any window longer than
 * the write journal's own life it's the only "when" there is.
 */

const SAVE_KEY = 'creek-view';

/** Which of the water's three sections are open — shared across whichever
 * collection is selected, not per-collection. */
interface WaterSections {
  now: boolean;
  changes: boolean;
  writes: boolean;
}

const DEFAULT_WATER_SECTIONS: WaterSections = { now: false, changes: false, writes: false };

/** The mode control — see the MODE section of the block above. These two are
 * different pictures, not two windows on one picture: `wiring` is the static
 * call-site map over 14 days, `traffic` is measured activity today. */
type CreekMode = 'wiring' | 'traffic';

/** Reads a saved mode, including the two names this control used before the
 * wiring/traffic split, so an existing localStorage blob doesn't silently
 * bounce her back to the default. */
function savedMode(raw: string | undefined): CreekMode {
  return raw === 'traffic' || raw === 'today' ? 'traffic' : 'wiring';
}

/** A saved selection is only restored if the restored MODE can actually draw
 * it — the two modes have different left banks, so a file lit in traffic mode
 * (or a caller in wiring) would dim the whole creek and light nothing. A lit
 * collection restores in either, the right bank being in both pictures. */
function restorableSelection(
  sel: CreekSelection | null | undefined,
  mode: CreekMode,
): CreekSelection | null {
  if (!sel) return null;
  if (sel.kind === 'collection') return sel;
  return (mode === 'traffic') === (sel.kind === 'caller') ? sel : null;
}

interface SavedCreekView {
  sel?: CreekSelection | null;
  mode?: string;
  trafficDays?: number;
  writesOn?: boolean;
  readsOn?: boolean;
  water?: Partial<WaterSections>;
}

function loadSaved(): SavedCreekView {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as SavedCreekView;
  } catch {
    return {};
  }
}

/** Wiring mode's fixed window. */
const WINDOW_DAYS = 14;
/** Traffic mode's poll interval, used for the today window only — a rolling
 * near-real-time view, not a live one; react-query's own background-tab guard
 * (see api.ts) does the rest. The longer windows barely move minute to
 * minute, so they aren't polled at all. */
const TODAY_POLL_MS = 60_000;

/**
 * The windows traffic mode can look through. All three are served by the same
 * endpoint and the same counters — `feature_usage` keeps a rolling ~33 days of
 * per-caller, per-collection buckets, so 7 and 30 cost nothing extra to ask
 * for. `phrase` is the wording every sentence about the window reuses, so the
 * subtitle, the tooltips and the legend can't drift apart from each other.
 */
const TRAFFIC_WINDOWS: { days: number; label: string; phrase: string }[] = [
  { days: 1, label: 'Today', phrase: 'today' },
  { days: 7, label: '7d', phrase: 'in the last 7 days' },
  { days: 30, label: '30d', phrase: 'in the last 30 days' },
];

/** A traffic row's tooltip: the states the opacity encodes, said in words —
 * so "quiet", "last written on this day" and "we can't place it at all" are
 * never left to be inferred from how grey something looks. */
function trafficRowTitle(c: CreekCollection, phrase: string): string {
  const state = writeState(c.writes, c.last_write, c.last_write_day);
  if (state === 'quiet') {
    return c.reads > 0
      ? `read ${c.reads.toLocaleString()}× ${phrase}, never written`
      : `nothing wrote it ${phrase}`;
  }
  const n = `${c.writes.toLocaleString()} ${c.writes === 1 ? 'write' : 'writes'} ${phrase}`;
  if (state === 'moved') return `${n}, last at ${relativeDayTime(c.last_write as string)}`;
  if (state === 'dated') return `${n}, last written ${relativeDay(c.last_write_day as string)}`;
  return `${n} — nothing recorded when`;
}

export function CreekView() {
  const [saved] = useState(loadSaved);
  const [mode, setMode] = useState<CreekMode>(() => savedMode(saved.mode));
  const [selection, setSelection] = useState<CreekSelection | null>(() =>
    restorableSelection(saved.sel, savedMode(saved.mode)),
  );
  const [trafficDays, setTrafficDays] = useState<number>(() =>
    TRAFFIC_WINDOWS.some((w) => w.days === saved.trafficDays) ? (saved.trafficDays as number) : 1,
  );
  const [writesOn, setWritesOn] = useState(saved.writesOn !== false);
  const [readsOn, setReadsOn] = useState(saved.readsOn !== false);
  const [waterSections, setWaterSections] = useState<WaterSections>({
    ...DEFAULT_WATER_SECTIONS,
    ...saved.water,
  });

  const traffic = mode === 'traffic';
  const days = traffic ? trafficDays : WINDOW_DAYS;
  const windowPhrase =
    TRAFFIC_WINDOWS.find((w) => w.days === trafficDays)?.phrase ?? `in the last ${trafficDays} days`;
  // Only the today window is a rolling view worth re-asking for; a 30-day sum
  // doesn't visibly move in a minute.
  const creek = useCreek(days, traffic && trafficDays === 1 ? { refetchInterval: TODAY_POLL_MS } : {});
  const files = useMemo(() => creek.data?.files ?? [], [creek.data]);
  const collections = useMemo(() => creek.data?.collections ?? [], [creek.data]);
  const unresolved = creek.data?.unresolved ?? [];
  const journalSince = creek.data?.journal_since ?? null;

  const sortMetric = sortMetricFor(writesOn, readsOn);

  // Traffic mode's two banks, both measured: callers inverted out of the
  // payload, and only the collections that actually moved. Both are computed
  // in either mode (they're cheap, and `traffic` gates what's drawn) so the
  // hook order never depends on the mode.
  const callers = useMemo(() => aggregateCallers(collections), [collections]);
  const shownCollections = useMemo(
    () => (traffic ? activeCollections(collections) : collections),
    [traffic, collections],
  );
  const quietCount = collections.length - shownCollections.length;

  const fileBank = useMemo(() => layoutFiles(files, sortMetric), [files, sortMetric]);
  const callerBank = useMemo(() => layoutCallers(callers, sortMetric), [callers, sortMetric]);
  const leftBankHeight = traffic ? callerBank.height : fileBank.height;
  const collectionBank = useMemo(
    () => layoutCollections(shownCollections, sortMetric),
    [shownCollections, sortMetric],
  );
  const ribbons = useMemo(
    () =>
      traffic
        ? buildTrafficRibbons(callers, callerBank, collectionBank)
        : buildRibbons(files, fileBank, collectionBank),
    [traffic, callers, callerBank, files, fileBank, collectionBank],
  );
  const shownRibbons = useMemo(
    () => visibleRibbons(ribbons, writesOn, readsOn),
    [ribbons, writesOn, readsOn],
  );
  const sets = useMemo(
    () => (traffic ? trafficSelectionSets(selection, callers) : selectionSets(selection, files)),
    [traffic, selection, callers, files],
  );

  // Reads-only mode: the Writes chip is off, so reads carry the width scale
  // and the accent-free color CreekView.module.css keys off `.ribbonReadOwn`.
  const readsOwnScale = !writesOn;
  // A quick lookup from collection id to its own row, for the Today-mode
  // freshness fade (write ribbons need their TARGET collection's last_write,
  // not the source file's).
  const collectionById = useMemo(
    () => new Map(collections.map((c) => [c.id, c])),
    [collections],
  );

  const canvasHeight = Math.max(leftBankHeight, collectionBank.height);
  const hasData = traffic
    ? callers.length > 0 || shownCollections.length > 0
    : files.length > 0 || collections.length > 0;

  // How she left it — same house pattern as the pond's SAVE_KEY effect.
  useEffect(() => {
    try {
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ sel: selection, mode, trafficDays, writesOn, readsOn, water: waterSections }),
      );
    } catch {
      // storage full or blocked — the creek just won't remember, which is fine
    }
  }, [selection, mode, trafficDays, writesOn, readsOn, waterSections]);

  function toggleWaterSection(key: keyof WaterSections) {
    setWaterSections((cur) => ({ ...cur, [key]: !cur[key] }));
  }

  // Independent layer chips, with the "never a blank creek" rule lifted from
  // creekMath (`toggleLayer`): turning off the last lit chip lights the
  // other one instead of leaving nothing drawn.
  function toggleWritesLayer() {
    const next = toggleLayer(writesOn, readsOn, 'writes');
    setWritesOn(next.writesOn);
    setReadsOn(next.readsOn);
  }
  function toggleReadsLayer() {
    const next = toggleLayer(writesOn, readsOn, 'reads');
    setWritesOn(next.writesOn);
    setReadsOn(next.readsOn);
  }

  // Esc clears the selection, same as the pond's card panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelection(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function pickFile(path: string) {
    setSelection((cur) => (cur?.kind === 'file' && cur.path === path ? null : { kind: 'file', path }));
  }

  function pickCaller(name: string) {
    setSelection((cur) => (cur?.kind === 'caller' && cur.name === name ? null : { kind: 'caller', name }));
  }

  function pickCollection(id: string) {
    setSelection((cur) =>
      cur?.kind === 'collection' && cur.id === id ? null : { kind: 'collection', id },
    );
  }

  // The two modes draw different left banks, so a lit file has nothing to be
  // lit ON in traffic mode (and a lit caller likewise in wiring). Rather than
  // leave a selection that dims the whole creek and lights nothing, switching
  // modes drops a selection the new mode can't show. A lit COLLECTION survives
  // the switch — the right bank is in both pictures.
  function changeMode(next: CreekMode) {
    setMode(next);
    setSelection((cur) => {
      if (cur === null || cur.kind === 'collection') return cur;
      return (next === 'traffic') === (cur.kind === 'caller') ? cur : null;
    });
  }

  const selectedFile =
    !traffic && selection?.kind === 'file'
      ? files.find((f) => f.path === selection.path) ?? null
      : null;
  const selectedCaller =
    traffic && selection?.kind === 'caller'
      ? callers.find((c) => c.name === selection.name) ?? null
      : null;
  const selectedCollection =
    selection?.kind === 'collection'
      ? collections.find((c) => c.id === selection.id) ?? null
      : null;

  const totalWrites = collections.reduce((n, c) => n + c.writes, 0);

  return (
    <section className={styles.view} aria-label="The creek">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>The creek</h2>
          <p className={styles.sub}>
            {!hasData
              ? 'Data moving between code and vault.'
              : traffic
                ? `${callers.length} callers · ${shownCollections.length} collections moved ${windowPhrase} · ${totalWrites.toLocaleString()} writes${
                    quietCount > 0 ? ` · ${quietCount} stayed quiet` : ''
                  }`
                : `${files.length} files · ${collections.length} collections · ${totalWrites.toLocaleString()} writes over ${days} days`}
            {!traffic && selection?.kind === 'file' ? ` — ${selection.path} lit` : ''}
            {traffic && selection?.kind === 'caller' ? ` — ${selection.name} lit` : ''}
            {selection?.kind === 'collection' ? ` — ${selection.id} lit` : ''}
          </p>
        </div>

        <div className={styles.controls}>
          <div className={styles.modeGroup} role="group" aria-label="What the ribbons mean">
            <button
              type="button"
              className={!traffic ? styles.modeBtnActive : styles.modeBtn}
              aria-pressed={!traffic}
              title="What the code can do — call sites in the source, over 14 days"
              onClick={() => changeMode('wiring')}
            >
              Wiring
            </button>
            <button
              type="button"
              className={traffic ? styles.modeBtnActive : styles.modeBtn}
              aria-pressed={traffic}
              title="What actually happened — measured reads and writes, by caller"
              onClick={() => changeMode('traffic')}
            >
              Traffic
            </button>
          </div>

          {/* The window only exists in traffic mode: wiring is a static map of
              call sites, which don't happen at a time, so a window over it
              would mean nothing. */}
          {traffic ? (
            <div className={styles.modeGroup} role="group" aria-label="How far back">
              {TRAFFIC_WINDOWS.map((w) => (
                <button
                  key={w.days}
                  type="button"
                  className={trafficDays === w.days ? styles.modeBtnActive : styles.modeBtn}
                  aria-pressed={trafficDays === w.days}
                  title={`What moved ${w.phrase}`}
                  onClick={() => setTrafficDays(w.days)}
                >
                  {w.label}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className={writesOn ? styles.layerChipOn : styles.layerChipOff}
            aria-pressed={writesOn}
            aria-label={writesOn ? 'Hide the writes layer' : 'Show the writes layer'}
            onClick={toggleWritesLayer}
          >
            Writes
          </button>
          <button
            type="button"
            className={readsOn ? styles.layerChipOn : styles.layerChipOff}
            aria-pressed={readsOn}
            aria-label={readsOn ? 'Hide the reads layer' : 'Show the reads layer'}
            onClick={toggleReadsLayer}
          >
            Reads
          </button>
          <Link to="/terrain/map" className={styles.back} aria-label="Back to the terrain map">
            ← Terrain
          </Link>
        </div>
      </header>

      {creek.isLoading ? <p className={styles.note}>Reading the creek…</p> : null}
      {creek.isError ? <p className={styles.note}>Couldn&rsquo;t read the creek.</p> : null}
      {creek.data && !hasData ? (
        <p className={styles.note}>No flow recorded in this window.</p>
      ) : null}

      {hasData ? (
        <div className={styles.body}>
          <div className={styles.stage}>
            <div
              className={styles.canvas}
              style={{ width: STAGE_W, height: canvasHeight }}
              role="group"
              aria-label={
                selection ? 'The creek, with a selection lit' : 'The creek — every file and collection'
              }
            >
              <svg
                className={styles.underlay}
                width={STAGE_W}
                height={canvasHeight}
                aria-hidden="true"
              >
                {shownRibbons.map((r) => {
                  const dimmed = ribbonDimmed(selection, r.source, r.collection);
                  const lit = selection !== null && !dimmed;
                  // Traffic mode only, and only for WRITE ribbons — reads are
                  // running totals with no per-event timestamp to fade by, so
                  // they always get a freshness of 1 (the legend says this
                  // outright). A write with no journal timestamp gets 1 too,
                  // not the floor: it definitely happened.
                  const target = collectionById.get(r.collection);
                  const freshness =
                    traffic && r.kind === 'write' && target && (target.last_write || target.last_write_day)
                      ? freshnessAt(target, new Date(), halfLifeForWindow(days))
                      : 1;
                  const readColor = readsOwnScale ? styles.ribbonReadOwn : styles.ribbonRead;
                  return (
                    <path
                      key={`${r.source} ${r.collection} ${r.kind}`}
                      d={r.d}
                      className={`${styles.ribbon} ${r.kind === 'write' ? styles.ribbonWrite : readColor}`}
                      style={{
                        strokeWidth: ribbonRenderWidth(r.kind, r.weight, readsOwnScale),
                        opacity: ribbonOpacity(r.kind, dimmed, lit, freshness),
                      }}
                    />
                  );
                })}
              </svg>

              {/* --- left bank: code files (wiring) or callers (traffic) ------ */}
              {(traffic ? callerBank.headers : fileBank.headers).map((h) => (
                <div
                  key={`lh:${h.key}`}
                  className={styles.groupHeader}
                  style={{ top: h.y, left: 0, width: LEFT_W, height: 20 }}
                >
                  {h.label}
                </div>
              ))}
              {!traffic
                ? fileBank.rows.map((row) => {
                    const dimmed = fileDimmed(selection, sets, row.key);
                    const lit = selection?.kind === 'file' && selection.path === row.key;
                    return (
                      <button
                        key={`f:${row.key}`}
                        type="button"
                        className={[styles.row, lit ? styles.rowLit : '', dimmed ? styles.rowDimmed : '']
                          .filter(Boolean)
                          .join(' ')}
                        style={{ top: row.y, left: 0, width: LEFT_W, height: ROW_H }}
                        aria-pressed={lit}
                        onClick={() => pickFile(row.key)}
                        title={row.key}
                      >
                        <span className={styles.rowName}>{row.item.path}</span>
                        <span className={styles.rowCount}>
                          {sortMetric === 'reads' ? fileReads(row.item) : fileWrites(row.item)}
                        </span>
                      </button>
                    );
                  })
                : callerBank.rows.map((row) => {
                    const dimmed = callerDimmed(selection, sets, row.key);
                    const lit = selection?.kind === 'caller' && selection.name === row.key;
                    const n = sortMetric === 'reads' ? row.item.reads : row.item.writes;
                    return (
                      <button
                        key={`p:${row.key}`}
                        type="button"
                        className={[styles.row, lit ? styles.rowLit : '', dimmed ? styles.rowDimmed : '']
                          .filter(Boolean)
                          .join(' ')}
                        style={{ top: row.y, left: 0, width: LEFT_W, height: ROW_H }}
                        aria-pressed={lit}
                        onClick={() => pickCaller(row.key)}
                        title={row.item.file ?? row.key}
                      >
                        <span className={styles.rowName}>{row.item.name}</span>
                        <span className={styles.rowCount}>{n.toLocaleString()}</span>
                      </button>
                    );
                  })}

              {/* --- right bank: vault collections ----------------------------- */}
              {collectionBank.headers.map((h) => (
                <div
                  key={`ch:${h.key}`}
                  className={styles.groupHeader}
                  style={{ top: h.y, left: RIGHT_X, width: RIGHT_W, height: 20 }}
                >
                  {h.label}
                </div>
              ))}
              {collectionBank.rows.map((row) => {
                const dimmed = collectionDimmed(selection, sets, row.key);
                const lit = selection?.kind === 'collection' && selection.id === row.key;
                // Traffic mode says the row's state in three ways at once:
                // opacity (by `writeState`), the count-or-"quiet" label, and
                // the tooltip. Wiring mode has no state to say — its rows are
                // call sites, which don't happen at a time — so it keeps the
                // plain dimmed/full behaviour.
                const state = writeState(row.item.writes, row.item.last_write, row.item.last_write_day);
                const opacity = traffic
                  ? trafficRowOpacity(
                      state,
                      dimmed,
                      freshnessAt(row.item, new Date(), halfLifeForWindow(days)),
                    )
                  : collectionRowOpacity(dimmed, 1);
                return (
                  <button
                    key={`c:${row.key}`}
                    type="button"
                    className={[styles.row, lit ? styles.rowLit : ''].filter(Boolean).join(' ')}
                    style={{
                      top: row.y,
                      left: RIGHT_X,
                      width: RIGHT_W,
                      height: ROW_H,
                      opacity,
                    }}
                    aria-pressed={lit}
                    onClick={() => pickCollection(row.key)}
                    title={
                      traffic ? `${row.item.id} — ${trafficRowTitle(row.item, windowPhrase)}` : row.item.id
                    }
                  >
                    <span className={styles.backingGlyph} aria-hidden="true">
                      {row.item.backing === 'sql' ? '▦' : '▤'}
                    </span>
                    <span className={styles.rowName}>{row.item.id}</span>
                    <span className={styles.rowCount}>
                      {traffic
                        ? trafficCountLabel(row.item, sortMetric)
                        : sortMetric === 'reads'
                          ? row.item.reads
                          : row.item.writes}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <aside className={styles.detail} aria-label="Detail">
            {selectedFile ? (
              <FileDetail
                file={selectedFile}
                onClose={() => setSelection(null)}
              />
            ) : selectedCaller ? (
              <CallerDetail
                caller={selectedCaller}
                windowPhrase={windowPhrase}
                onClose={() => setSelection(null)}
                onPickCollection={pickCollection}
              />
            ) : selectedCollection ? (
              <CollectionDetail
                collection={selectedCollection}
                files={files}
                days={days}
                traffic={traffic}
                windowPhrase={windowPhrase}
                onClose={() => setSelection(null)}
                onPickFile={pickFile}
                water={waterSections}
                onToggleWater={toggleWaterSection}
              />
            ) : (
              <Legend
                totalWrites={totalWrites}
                unresolvedCount={unresolved.length}
                traffic={traffic}
                windowPhrase={windowPhrase}
                quietCount={quietCount}
                writesOn={writesOn}
                readsOn={readsOn}
                journalSince={journalSince}
              />
            )}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

/** What one call site says: "verb collection · line N", the snippet
 * underneath, and the whole row is a link to `/code` at that exact line —
 * the page built in parallel that highlights + scrolls to it. */
function FileDetail({ file, onClose }: { file: CreekFile; onClose: () => void }) {
  const calls = sortedCalls(file);
  return (
    <>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailTitle}>{file.path}</div>
          <p className={styles.detailMeta}>
            {file.area} · {fileWrites(file)} writes · {fileReads(file)} reads
          </p>
        </div>
        <button type="button" className={styles.detailClose} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <p className={styles.detailLabel}>Calls</p>
      <div className={styles.callList}>
        {calls.map((c) => (
          <a
            key={`${c.line}:${c.collection}:${c.verb}`}
            className={styles.callRow}
            href={codeHref(file.path, c.line)}
          >
            <div className={styles.callHead}>
              <span>
                <span className={styles.callVerb}>{c.verb}</span> {c.collection}
              </span>
              <span className={styles.callVerb}>line {c.line}</span>
            </div>
            <div className={styles.callSnippet}>{c.snippet}</div>
          </a>
        ))}
        {calls.length === 0 ? (
          <p className={styles.detailCaveat}>No calls recorded for this file in this window.</p>
        ) : null}
      </div>
    </>
  );
}

/** What one CALLER says — traffic mode's left-bank panel. A caller is a
 * process (`gunicorn`, `run_dispatcher`, a script's own name), so there's no
 * call-site list to show the way FileDetail has one; what it has instead is
 * the collections it actually moved today, each tapping through to that
 * collection. Its source file gets a `/code` link only when the server could
 * name one — for gunicorn and the Rust binaries there honestly isn't one. */
function CallerDetail({
  caller,
  windowPhrase,
  onClose,
  onPickCollection,
}: {
  caller: TrafficCaller;
  windowPhrase: string;
  onClose: () => void;
  onPickCollection: (id: string) => void;
}) {
  const touches = sortedTouches(caller);
  return (
    <>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailTitle}>{caller.name}</div>
          <p className={styles.detailMeta}>
            caller · {caller.writes.toLocaleString()} writes ·{' '}
            {caller.reads.toLocaleString()} reads {windowPhrase}
          </p>
        </div>
        <button type="button" className={styles.detailClose} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {caller.file ? (
        <p className={styles.detailLabel}>
          <a
            className={styles.callerName}
            href={`/code?${new URLSearchParams({ repo: 'skeleton', path: caller.file }).toString()}`}
          >
            {caller.file}
          </a>
        </p>
      ) : (
        <p className={styles.detailCaveat}>
          A process name, not a file — the counters record who ran, never which line.
        </p>
      )}

      <p className={styles.detailLabel}>What it moved {windowPhrase}</p>
      <div className={styles.callerList}>
        {touches.map((t) => (
          <button
            key={t.collection}
            type="button"
            className={styles.callerRow}
            onClick={() => onPickCollection(t.collection)}
          >
            <span className={styles.callerName}>{t.collection}</span>
            <span className={styles.callerCounts}>
              {t.writes.toLocaleString()}w · {t.reads.toLocaleString()}r
            </span>
          </button>
        ))}
        {touches.length === 0 ? (
          <p className={styles.detailCaveat}>It touched nothing in this window.</p>
        ) : null}
      </div>
    </>
  );
}

/** What a collection says: itself, the files that touch it (each a link that
 * SELECTS that file — staying on the creek, not navigating away), who
 * actually moved it in the window, and below that "the water" — three lazy
 * sections for what the data IS and WAS. */
function CollectionDetail({
  collection,
  files,
  days,
  traffic,
  windowPhrase,
  onClose,
  onPickFile,
  water,
  onToggleWater,
}: {
  collection: CreekCollection;
  files: readonly CreekFile[];
  days: number;
  traffic: boolean;
  windowPhrase: string;
  onClose: () => void;
  onPickFile: (path: string) => void;
  water: WaterSections;
  onToggleWater: (key: keyof WaterSections) => void;
}) {
  const touching = filesTouching(files, collection.id);
  const callers = sortedCallers(collection);

  return (
    <>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailTitle}>{collection.id}</div>
          <p className={styles.detailMeta}>
            {collection.backing} · {collection.writes.toLocaleString()} writes ·{' '}
            {collection.reads.toLocaleString()} reads
          </p>
        </div>
        <button type="button" className={styles.detailClose} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {/* The same three-state honesty the row's opacity carries, spelled out
          where there's room for a sentence. Traffic mode only — in wiring mode
          the counts aren't what the picture is about. */}
      {traffic ? (
        <p className={styles.detailCaveat}>{trafficRowTitle(collection, windowPhrase)}.</p>
      ) : null}

      {collection.backing === 'sql' ? (
        <p className={styles.detailCaveat}>
          SQLite is the record here — the JSON file is a one-way mirror, never read back.
        </p>
      ) : null}

      <p className={styles.detailLabel}>
        {traffic ? 'Files that could touch it' : 'Files that touch it'}
      </p>
      <div className={styles.fileList}>
        {touching.map((f) => (
          <button
            key={f.path}
            type="button"
            className={styles.fileRow}
            onClick={() => onPickFile(f.path)}
          >
            <span className={styles.callerName}>{f.path}</span>
            <span className={styles.callerCounts}>{fileWrites(f)}w</span>
          </button>
        ))}
        {touching.length === 0 ? (
          <p className={styles.detailCaveat}>No file in this repo calls into it directly.</p>
        ) : null}
      </div>

      <p className={styles.detailLabel}>
        Who actually moved it ({traffic ? 'today' : `last ${days} days`})
      </p>
      <div className={styles.callerList}>
        {callers.map((c) =>
          c.file ? (
            <a
              key={c.name}
              className={styles.callerRow}
              href={`/code?${new URLSearchParams({ repo: 'skeleton', path: c.file }).toString()}`}
            >
              <span className={styles.callerName}>{c.name}</span>
              <span className={styles.callerCounts}>
                {c.writes}w · {c.reads}r
              </span>
            </a>
          ) : (
            <div key={c.name} className={styles.callerRow}>
              <span className={styles.callerName}>{c.name}</span>
              <span className={styles.callerCounts}>
                {c.writes}w · {c.reads}r
              </span>
            </div>
          ),
        )}
        {callers.length === 0 ? (
          <p className={styles.detailCaveat}>Nobody moved this collection in the window.</p>
        ) : null}
      </div>

      <div className={styles.waterSections}>
        <NowSection
          id={collection.id}
          open={water.now}
          onToggle={() => onToggleWater('now')}
        />
        <ChangesSection
          id={collection.id}
          open={water.changes}
          onToggle={() => onToggleWater('changes')}
        />
        <WritesSection
          id={collection.id}
          open={water.writes}
          onToggle={() => onToggleWater('writes')}
        />
      </div>
    </>
  );
}

/** One water section's header: a real ~40px button, title, and a chevron that
 * rotates open — RetiredCountersCard's own row-toggle idiom, reused here for
 * the same "tap the row, chevron turns" grammar. */
function WaterSectionHead({
  title,
  open,
  onToggle,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={styles.waterHead} onClick={onToggle} aria-expanded={open}>
      <span>{title}</span>
      <span
        className={`${styles.waterChevron} ${open ? styles.waterChevronOpen : ''}`}
        aria-hidden="true"
      >
        &#9654;
      </span>
    </button>
  );
}

/** Now: the collection's current contents, pretty-printed by the server and
 * capped at 100k chars. Only fetches once opened (api.ts's `enabled: open`). */
function NowSection({ id, open, onToggle }: { id: string; open: boolean; onToggle: () => void }) {
  const now = useCollectionNow(id, open);
  return (
    <div className={styles.waterSection}>
      <WaterSectionHead title="Now" open={open} onToggle={onToggle} />
      {open ? (
        <div className={styles.waterBody}>
          {now.isLoading ? <p className={styles.detailCaveat}>Reading the current contents…</p> : null}
          {now.isError ? <p className={styles.detailCaveat}>Couldn&rsquo;t read the current contents.</p> : null}
          {now.data && !now.data.exists ? (
            <p className={styles.detailCaveat}>nothing stored yet</p>
          ) : null}
          {now.data && now.data.exists ? (
            <>
              <p className={styles.nowMeta}>
                {now.data.backing} · {now.data.bytes.toLocaleString()} bytes
              </p>
              <pre className={styles.nowPre}>{now.data.pretty}</pre>
              {now.data.truncated ? (
                <p className={styles.detailCaveat}>
                  showing first 100k characters of {now.data.bytes.toLocaleString()}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The line-tint class for one classified diff line — writes/adds get the
 * green wash, dels get red, hunk/meta headers are muted, context is plain. */
const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: styles.diffAdd,
  del: styles.diffDel,
  hunk: styles.diffHunk,
  meta: styles.diffMeta,
  ctx: styles.diffCtx,
};

/** One commit's inline diff, rendered directly under its row. A blank line
 * still needs a real (non-empty) box in the DOM or its background/height
 * collapses to nothing, so it renders a non-breaking space instead. */
function DiffBlock({ diff }: { diff: UseQueryResult<CreekDiff> }) {
  if (diff.isLoading) return <p className={styles.detailCaveat}>Reading the diff…</p>;
  if (diff.isError) return <p className={styles.detailCaveat}>Couldn&rsquo;t read this diff.</p>;
  if (!diff.data) return null;
  const lines = diff.data.diff.split('\n');
  return (
    <div className={styles.diffBlock}>
      {lines.map((line, i) => (
        <div key={i} className={`${styles.diffLine} ${DIFF_LINE_CLASS[classifyDiffLine(line)]}`}>
          {line === '' ? ' ' : line}
        </div>
      ))}
      {diff.data.truncated ? <p className={styles.detailCaveat}>diff truncated</p> : null}
    </div>
  );
}

/** Changes: hourly-batched git history. `note` (the server's own honesty
 * about that batching) always shows first. Tapping a commit row opens its
 * diff inline right below the row; tapping again collapses it. Switching to
 * a different collection resets which commit (if any) is open. */
function ChangesSection({ id, open, onToggle }: { id: string; open: boolean; onToggle: () => void }) {
  const history = useCollectionHistory(id, open, 30);
  const [openSha, setOpenSha] = useState<string | null>(null);
  useEffect(() => {
    setOpenSha(null);
  }, [id]);
  const diff = useCollectionDiff(id, openSha, open);

  return (
    <div className={styles.waterSection}>
      <WaterSectionHead title="Changes" open={open} onToggle={onToggle} />
      {open ? (
        <div className={styles.waterBody}>
          {history.isLoading ? <p className={styles.detailCaveat}>Reading the history…</p> : null}
          {history.isError ? <p className={styles.detailCaveat}>Couldn&rsquo;t read the history.</p> : null}
          {history.data ? (
            <>
              <p className={styles.waterNote}>{history.data.note}</p>
              {!history.data.tracked ? (
                <p className={styles.detailCaveat}>no git history for this file</p>
              ) : (
                <div className={styles.commitList}>
                  {history.data.commits.map((c) => {
                    const commitOpen = openSha === c.sha;
                    return (
                      <div key={c.sha}>
                        <button
                          type="button"
                          className={styles.commitRow}
                          onClick={() => setOpenSha(commitOpen ? null : c.sha)}
                          aria-expanded={commitOpen}
                        >
                          <span className={styles.commitTime}>{relativeDayTime(c.ts)}</span>
                          <span className={styles.commitSubject}>{c.subject}</span>
                          <span className={styles.commitCounts}>
                            <span className={c.added !== null ? styles.commitAdded : styles.commitCountMuted}>
                              +{c.added ?? '—'}
                            </span>
                            <span className={c.removed !== null ? styles.commitRemoved : styles.commitCountMuted}>
                              −{c.removed ?? '—'}
                            </span>
                          </span>
                        </button>
                        {commitOpen ? <DiffBlock diff={diff} /> : null}
                      </div>
                    );
                  })}
                  {history.data.commits.length === 0 ? (
                    <p className={styles.detailCaveat}>No commits in this window.</p>
                  ) : null}
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One JSON-Patch-flavored op as a plain line: `path: from → to`, or just the
 * op's own `note` when it's note-only. `from`/`to` are `unknown` on the wire
 * (JSON-Patch values aren't always strings), so they're rendered through
 * `String()` — good enough for a diff line, never thrown on. */
function patchOpLine(op: CreekPatchOp): { path: string; from: string; to: string } | null {
  if (op.from === undefined && op.to === undefined) return null;
  const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : String(v));
  return { path: op.path, from: fmt(op.from), to: fmt(op.to) };
}

/** Writes: the capture journal for this collection. `note` is the server's
 * own honesty about what window it can actually see; `capturing_since` only
 * shows once the journal has a real start date. */
function WritesSection({ id, open, onToggle }: { id: string; open: boolean; onToggle: () => void }) {
  const writes = useCollectionWrites(id, open, 50);
  return (
    <div className={styles.waterSection}>
      <WaterSectionHead title="Writes" open={open} onToggle={onToggle} />
      {open ? (
        <div className={styles.waterBody}>
          {writes.isLoading ? <p className={styles.detailCaveat}>Reading the write journal…</p> : null}
          {writes.isError ? <p className={styles.detailCaveat}>Couldn&rsquo;t read the write journal.</p> : null}
          {writes.data ? (
            <>
              <p className={styles.waterNote}>{writes.data.note}</p>
              {writes.data.capturing_since ? (
                <p className={styles.waterSubNote}>capturing since {writes.data.capturing_since}</p>
              ) : null}
              {writes.data.events.length === 0 ? (
                <p className={styles.detailCaveat}>
                  no writes captured yet — the journal starts recording from tonight
                </p>
              ) : (
                <div className={styles.eventList}>
                  {writes.data.events.map((e, i) => (
                    <div key={`${e.ts}:${i}`} className={styles.eventRow}>
                      <div className={styles.eventHead}>
                        <span className={styles.commitTime}>{relativeDayTime(e.ts)}</span>
                        <span className={styles.callerChip}>{e.caller}</span>
                        <span className={styles.eventVerb}>{e.verb}</span>
                      </div>
                      {e.patch && e.patch.length > 0 ? (
                        <div className={styles.patchList}>
                          {e.patch.map((op, j) => {
                            const line = patchOpLine(op);
                            return (
                              <div key={j} className={styles.patchOp}>
                                {op.note ? (
                                  <span className={styles.patchNote}>{op.note}</span>
                                ) : line ? (
                                  <>
                                    <span className={styles.patchPath}>{line.path}</span>
                                    {': '}
                                    <span className={styles.patchVal}>{line.from}</span>
                                    {' → '}
                                    <span className={styles.patchVal}>{line.to}</span>
                                  </>
                                ) : (
                                  <span className={styles.patchPath}>{op.path}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                      {e.truncated ? (
                        <p className={styles.detailCaveat}>…and more (patch capped)</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Nothing selected: a short plain-English legend of what the drawing means,
 * said once rather than as a tooltip on every row. Reacts to the mode and
 * the two layer chips rather than describing a fixed drawing — the swatches
 * and the wording only show what's actually on screen right now. */
function Legend({
  totalWrites,
  unresolvedCount,
  traffic,
  windowPhrase,
  quietCount,
  writesOn,
  readsOn,
  journalSince,
}: {
  totalWrites: number;
  unresolvedCount: number;
  traffic: boolean;
  windowPhrase: string;
  quietCount: number;
  writesOn: boolean;
  readsOn: boolean;
  journalSince: string | null;
}) {
  // Reads-only: the Writes chip is off, so reads carry the width scale and
  // the legend has to say so honestly rather than describing hairlines that
  // aren't what's drawn right now.
  const readsOnly = readsOn && !writesOn;
  return (
    <div className={styles.legend}>
      {/* The mode paragraph comes FIRST and names what a ribbon means, because
          that's the thing the drawing can't say for itself — and getting it
          wrong is what made a collection nobody had touched all day look busy. */}
      <p>
        {traffic ? (
          <>
            <strong>Traffic</strong> — what actually happened today. A ribbon is
            reads and writes that really ran, counted.
          </>
        ) : (
          <>
            <strong>Wiring</strong> — what the code <em>can</em> do. A ribbon is
            call sites in the source, not runs: a collection draws a write ribbon
            because some file contains a line that writes it, even if nothing has
            for months.
          </>
        )}
      </p>
      <p>
        <strong>Left bank</strong> is{' '}
        {traffic ? (
          <>
            who moved it — the processes the counters actually recorded
            (gunicorn, the dispatchers, each script by name), split into those
            that wrote and those that only read. They&rsquo;re processes, not
            files: nothing here records which line ran.
          </>
        ) : (
          <>
            code — every file that reads or writes a collection, grouped by where
            it lives (server, routes, scripts, tools).
          </>
        )}
      </p>
      <p>
        <strong>Right bank</strong> is the vault&rsquo;s own collections, grouped by
        how they&rsquo;re stored: <strong>▦ sql</strong> (the database of record) or{' '}
        <strong>▤ json</strong> (a plain file).
      </p>
      {readsOnly ? (
        <p>
          Writes are hidden — reads carry the ink here instead, on their{' '}
          <strong>own</strong> scale, never comparable to write widths.
        </p>
      ) : (
        <p>A ribbon&rsquo;s width is how much it writes — the busier the flow, the thicker the ribbon.</p>
      )}
      {writesOn ? (
        <div className={styles.legendKey}>
          <span className={`${styles.legendSwatch} ${styles.legendSwatchWrite}`} aria-hidden="true" />
          <span>writes carry the ink</span>
        </div>
      ) : null}
      {readsOn ? (
        <div className={styles.legendKey}>
          <span
            className={`${styles.legendSwatch} ${readsOnly ? styles.legendSwatchReadOwn : styles.legendSwatchRead}`}
            aria-hidden="true"
          />
          <span>
            {readsOnly
              ? 'reads on their own scale — never comparable to write widths'
              : 'reads are hairlines — context, not the story'}
          </span>
        </div>
      ) : null}
      <p>
        Tap {traffic ? 'a caller' : 'a file'} or a collection to follow its flow; tap again, or
        Esc, to clear it.
      </p>
      <p>
        {totalWrites.toLocaleString()} writes tracked {traffic ? windowPhrase : 'in this window'}.
      </p>
      {traffic ? (
        <>
          {quietCount > 0 ? (
            <p>
              {quietCount} {quietCount === 1 ? 'collection' : 'collections'} nothing touched{' '}
              {windowPhrase} aren&rsquo;t drawn at all — they&rsquo;re on the Wiring map.
            </p>
          ) : null}
          {/* The three row states, said plainly. This paragraph replaced a
              single fade that painted "quiet" and "we can't tell" the same
              grey, which is the ambiguity that made the page unreadable. */}
          <p>
            A right-bank row <strong>fades by how recently</strong> the write journal saw it
            {journalSince ? `, which has been capturing since ${relativeDayTime(journalSince)}` : ''}.
            A row that moved but has <strong>no timestamp</strong> stays at full strength and says
            so on hover — it definitely happened, the journal just can&rsquo;t place it. A row
            reading <strong>quiet</strong> was genuinely never written today.
          </p>
          <p>
            The journal only sees writes through the store seam, so typed stores (habits,
            expenses, cards) can move without ever getting a timestamp. Counts are running
            totals refreshed about every minute; reads don&rsquo;t fade at all, having no
            per-read moment to fade from.
          </p>
        </>
      ) : null}
      {unresolvedCount > 0 ? (
        <p className={styles.legendUnresolved}>
          {unresolvedCount} {unresolvedCount === 1 ? 'call' : 'calls'} couldn&rsquo;t be traced
          statically.
        </p>
      ) : null}
    </div>
  );
}
