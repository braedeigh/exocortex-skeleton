import { useEffect, useMemo, useRef, useState } from 'react';
import { readThemeInk } from './terrainCanvas';
import {
  compact,
  cumulative,
  facetVelocityBins,
  frontChipLabel,
  monthLabel,
  monthTicks,
  monthlyRollup,
  nearestTime,
  niceTicks,
  shortDate,
  splitVelocityBars,
  sumSince,
  valueAt,
  velocityBars,
  windowBars,
  windowPoints,
  type BinUnit,
  type FacetSeries,
  type GrowthData,
  type GrowthFacets,
  type LitFacet,
  type SeriesPoint,
  type VelocityBar,
} from './growthMath';
import styles from './TerrainGrowthView.module.css';
import { TerrainRoomHeader } from './TerrainRoomHeader';

/**
 * TerrainGrowthView — "how it's grown", one of the terrain's rooms.
 *
 * The map shows the system in SPACE and the attention room ranks it by where
 * she goes; this room is the same organism along TIME — the codebase and the
 * vault as two curves that only ever accumulate, plus how fast files get
 * created underneath that accumulation. Reads
 * GET /api/observatory/terrain/growth (per-day deltas from the code-history
 * tables, codestore.growth_series) and integrates them client-side, because
 * the date window decides what "so far" means (growthMath.windowPoints).
 *
 * The drawing follows the dataviz method, decided before any code:
 *
 * - **The job is trend-over-time with two series that ARE the subject** (app
 *   code vs personal vault), so: multi-line charts, categorical colour.
 * - **Two measures, two charts, never a dual axis.** Files and lines live on
 *   scales three orders apart; one shared frame would flatten whichever loses.
 * - **The pair is validated, not eyeballed** — the skill's palette script
 *   passed indigo #6a7acc / amber #d4880a on the light surface and #6a7acc /
 *   #c8820c on the dark (CVD ΔE ≥ 25 on every pair). The amber's light-mode
 *   contrast warning is relieved the way the rules require: a legend, direct
 *   end labels, and the monthly table below carry identity and value without
 *   colour. The lit hue (teal #0d9488, HUES.*.lit below) was validated as a
 *   THIRD member of the SAME trio, not a fresh pair —
 *   `validate_palette.js "#6a7acc,#d4880a,#0d9488" --mode light` and the dark
 *   trio swapping in #c8820c both read ALL CHECKS PASS, so a lit subject
 *   reads as a genuinely distinct third identity, never a tint of either repo.
 * - **Marks per spec:** 2px round-capped lines, ≥8px end dots ringed in the
 *   surface colour, hairline solid gridlines, y-axis always anchored at zero —
 *   a growth curve read against a clipped baseline is the classic chart lie.
 * - **The hover layer is part of the chart:** a crosshair that snaps to the
 *   nearest recorded day, one tooltip listing every series on screen (value
 *   leads, name follows, line-key strokes — the lit facet's own value included
 *   whenever one is lit) — and nothing gates on it, because the table view
 *   holds every number reachable by tap.
 * - **The velocity panel is the Files curve's derivative, so it sits directly
 *   under it and shares its window control and x-extent** — the curve reads
 *   as the running total, the bars directly below as the rate that produced
 *   it, one object read top to bottom. Part-to-whole per bin (skeleton vs
 *   vault, or lit vs rest once something's lit) is a stacked bar, same
 *   categorical pair and legend as the curve above it. Stack segments are
 *   built from a generic `{id,label,color}` list (fileSeries normally, a
 *   two-entry lit/rest list once lit) rather than two hardcoded fields, which
 *   is what let the facet split land as more rows, not a rewrite. Bin width
 *   is a direct choice now, not window-derived: a small Day/Week/Month
 *   control sits next to the panel title (default Day, independent of the
 *   time-window preset, persisted separately — localStorage 'growth-bin').
 *   growthMath.velocityBinUnit still exists and is still tested (a
 *   window-driven default, in case something wants one again) but no longer
 *   drives this panel — a daily bar over "All" can run thin, and that's hers
 *   to choose now rather than a size the maths guessed for her. The panel
 *   title still says which unit is live ("files born / day|week|month").
 * - **A chip row lights ONE place or front at a time** (GET
 *   .../growth/facets for the available chips with live file counts, GET
 *   .../growth/facet?ns=&tag= for the lit one's own born/died series, both
 *   routes/terrain.py) — emphasis, not a filter, the wiki-pond's own rule:
 *   the two repo totals stay drawn, dimmed and thinner (same colours, lower
 *   opacity — colour follows entity, this never repaints a line), while the
 *   lit subset's own cumulative curve draws at full strength as a third line
 *   in the validated teal. The velocity bars split the same total-per-bin
 *   into lit vs rest through the same generic segment machinery the panel
 *   already had. The lines (added/removed) chart has no facet data to show,
 *   so it dims with an honest note ("lines don't facet — yet") instead of
 *   quietly pretending to split. The lit selection persists to localStorage
 *   ('growth-lit'), same try/catch pattern as 'growth-bin' and the Flow
 *   lane's own 'flow-filters'. Fetches for both new endpoints stay plain
 *   fetch/useEffect, matching how this room already loads its main series —
 *   react-query never got introduced here just for the overlay.
 *
 * Prompt that produced this file: "I want it to be able to let me build more
 * UI like terrain and make visualizations of my entire codebase/file system
 * as it grows." Prompt that added the velocity panel: "in the growth charts
 * show the velocity of files being created — how many files are generated on
 * a given day, as bars." Prompt that added the lit layer: "some way to
 * highlight subjects or like places in the growth curves." Prompt that
 * changed the velocity bin control: "i want the velocity bars to be by day
 * not month or like interchangeable."
 */

const WINDOWS: readonly { days: number | null; label: string }[] = [
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: null, label: 'All' },
];

/** Series colours per theme mode — the validated pairs (see the docblock).
 * The indigo is the theme's own `evening` accent; the amber is `morning`,
 * darkened one step in dark mode to sit inside the validator's band. `lit` is
 * the same teal in both modes — validated as a third trio member against
 * BOTH surfaces at once, so it doesn't need a mode-specific darken the way
 * the amber did. */
const HUES = {
  light: { skeleton: '#6a7acc', vault: '#d4880a', lit: '#0d9488' },
  dark: { skeleton: '#6a7acc', vault: '#c8820c', lit: '#0d9488' },
} as const;

/** The lit-vs-rest split's neutral: everything NOT the lit subject, in every
 * chart it appears (bars, dimmed lines). One constant so "rest" always reads
 * as the same muted grey rather than drifting per chart. */
const REST_HUE = 'color-mix(in srgb, var(--text) 22%, transparent)';

/** The velocity panel's bin width: a direct choice now (her call — see the
 * docblock), not derived from the time window. Order is display order. */
const BIN_UNITS: readonly { unit: BinUnit; label: string }[] = [
  { unit: 'day', label: 'Day' },
  { unit: 'week', label: 'Week' },
  { unit: 'month', label: 'Month' },
];

const LIT_STORAGE_KEY = 'growth-lit';
const BIN_STORAGE_KEY = 'growth-bin';

/** Read/write pairs for the two bits of chip-row state that persist —
 * same try/catch-and-swallow shape as flow/filters.ts's
 * readFlowFilters/writeFlowFilters, kept local here rather than in
 * growthMath.ts (that file is deliberately DOM-free; see its docblock). */
function readLitFacet(): LitFacet | null {
  try {
    const raw = localStorage.getItem(LIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.ns === 'place' || parsed.ns === 'front') && typeof parsed.tag === 'string') {
      return { ns: parsed.ns, tag: parsed.tag };
    }
  } catch {
    // storage blocked or malformed — nothing lit to start
  }
  return null;
}

function writeLitFacet(lit: LitFacet | null): void {
  try {
    if (lit) localStorage.setItem(LIT_STORAGE_KEY, JSON.stringify(lit));
    else localStorage.removeItem(LIT_STORAGE_KEY);
  } catch {
    // storage full/blocked — the selection just won't persist
  }
}

function readBinUnit(): BinUnit {
  try {
    const raw = localStorage.getItem(BIN_STORAGE_KEY);
    if (raw === 'day' || raw === 'week' || raw === 'month') return raw;
  } catch {
    // storage blocked — fall through to the default
  }
  return 'day';
}

function writeBinUnit(unit: BinUnit): void {
  try {
    localStorage.setItem(BIN_STORAGE_KEY, unit);
  } catch {
    // storage full/blocked — the choice just won't persist
  }
}

interface ChartSeries {
  id: string;
  label: string;
  color: string;
  points: SeriesPoint[]; // full-history cumulative; windowed inside the chart
  dimmed?: boolean; // the lit overlay's "still drawn, just receding" state
}

/** The generic shape a stacked velocity segment needs (also VelocityChart's
 * own prop type below) — id/label/color only, so both the two-repo default
 * and the lit/rest split draw through the identical stacking code. */
interface VelocitySegment {
  id: string;
  label: string;
  color: string;
}

export function TerrainGrowthView() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [days, setDays] = useState<number | null>(null); // All — growth is the long story
  const [binUnit, setBinUnit] = useState<BinUnit>(() => readBinUnit()); // her call, not window-derived
  const dark = useMemo(() => readThemeInk().dark, []);
  const hues = dark ? HUES.dark : HUES.light;

  // The chip row's contents (available places/fronts + live counts) and
  // which one, if any, is lit — see the docblock's "chip row" bullet.
  const [facets, setFacets] = useState<GrowthFacets | null>(null);
  const [lit, setLit] = useState<LitFacet | null>(() => readLitFacet());
  const [facetSeries, setFacetSeries] = useState<FacetSeries | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/observatory/terrain/growth', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: GrowthData) => {
        if (!alive) return;
        setData(d);
        setState('ready');
      })
      .catch(() => {
        if (alive) setState('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  // The chip row's own data — independent of the main growth fetch above, so
  // a slow facets read never blocks the curves from drawing. Plain fetch/
  // useEffect, matching how the room already loads growth (no react-query).
  useEffect(() => {
    let alive = true;
    fetch('/api/observatory/terrain/growth/facets', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: GrowthFacets) => {
        if (alive) setFacets(d);
      })
      .catch(() => {
        // the chip row just stays empty — the curves below don't depend on it
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    writeBinUnit(binUnit);
  }, [binUnit]);

  useEffect(() => {
    writeLitFacet(lit);
    if (!lit) {
      setFacetSeries(null);
      return;
    }
    let alive = true;
    fetch(
      `/api/observatory/terrain/growth/facet?ns=${encodeURIComponent(lit.ns)}&tag=${encodeURIComponent(lit.tag)}`,
      { credentials: 'include' },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: FacetSeries) => {
        if (alive) setFacetSeries(d);
      })
      .catch(() => {
        if (alive) setFacetSeries(null);
      });
    return () => {
      alive = false;
    };
  }, [lit]);

  const toggleLit = (ns: LitFacet['ns'], tag: string) => {
    setLit((cur) => (cur && cur.ns === ns && cur.tag === tag ? null : { ns, tag }));
  };

  const nowSec = Date.now() / 1000;
  const from = days === null ? null : nowSec - days * 86400;

  // One cumulative integration per repo per measure, over ALL history — the
  // window only slices afterwards, so flipping presets never re-integrates.
  const fileSeries: ChartSeries[] = useMemo(
    () =>
      (data?.repos ?? []).map((r) => ({
        id: r.id,
        label: r.name,
        color: hues[r.id as keyof typeof hues] ?? hues.skeleton,
        points: cumulative(r.days, (d) => d.born - d.died),
      })),
    [data, hues],
  );
  const lineSeries: ChartSeries[] = useMemo(
    () =>
      (data?.repos ?? []).map((r) => ({
        id: r.id,
        label: r.name,
        color: hues[r.id as keyof typeof hues] ?? hues.skeleton,
        points: cumulative(r.days, (d) => d.added - d.removed),
      })),
    [data, hues],
  );

  // The lit chip's own display name: places carry a server-side label,
  // fronts don't (frontChipLabel formats the raw tag instead).
  const litLabel = useMemo(() => {
    if (!lit) return null;
    if (lit.ns === 'place') return facets?.places.find((p) => p.id === lit.tag)?.label ?? lit.tag;
    return frontChipLabel(lit.tag);
  }, [lit, facets]);

  // The lit facet's own cumulative curve — same integration fileSeries uses,
  // just over the facet's {date, born, died} rows instead of a repo's full
  // GrowthDay ones (cumulative() is generic over both, see growthMath.ts).
  const litPoints = useMemo(
    () => (facetSeries ? cumulative(facetSeries.days, (d) => d.born - d.died) : []),
    [facetSeries],
  );

  // What the Files LineChart actually draws: unlit, just fileSeries; lit,
  // the two repo curves dim (same colour, lower opacity/weight — colour
  // follows entity) and the lit curve joins at full strength as a third line.
  const fileSeriesForChart: ChartSeries[] = useMemo(() => {
    if (!lit) return fileSeries;
    return [
      ...fileSeries.map((s) => ({ ...s, dimmed: true })),
      { id: `facet:${lit.ns}:${lit.tag}`, label: litLabel ?? lit.tag, color: hues.lit, points: litPoints },
    ];
  }, [lit, fileSeries, litPoints, litLabel, hues]);

  // The legend names whatever the Files chart is actually drawing — the lit
  // entry joins it at full strength too, since the legend is identity, not a
  // chart mark (it doesn't dim). No `points` needed here — Legend only ever
  // reads id/label/color.
  const legendSeries = useMemo(
    () => (lit ? [...fileSeries, { id: 'lit', label: litLabel ?? lit.tag, color: hues.lit }] : fileSeries),
    [lit, fileSeries, litLabel, hues],
  );

  // The velocity panel: files-BORN binned by whichever unit the Day/Week/
  // Month control picked (her call, not window-derived — see the docblock),
  // over ALL history like the curves above, sliced to the window afterwards.
  const velocity = useMemo(
    () => velocityBars((data?.repos ?? []).map((r) => ({ id: r.id, days: r.days })), binUnit),
    [data, binUnit],
  );
  // Lit: re-key each bin's total into {lit, rest} from the facet's own
  // per-bin born counts, binned by the SAME unit so the bins line up.
  const litBins = useMemo(
    () => (facetSeries ? facetVelocityBins(facetSeries.days, binUnit) : null),
    [facetSeries, binUnit],
  );
  const velocityWindowed = useMemo(() => {
    const bars = lit && litBins ? splitVelocityBars(velocity, litBins) : velocity;
    return windowBars(bars, from);
  }, [velocity, lit, litBins, from]);
  const velocitySegments: VelocitySegment[] = lit
    ? [
        { id: 'lit', label: litLabel ?? lit.tag, color: hues.lit },
        { id: 'rest', label: 'rest', color: REST_HUE },
      ]
    : fileSeries;

  // The exact x-extent the Files LineChart below will compute for itself
  // (same series, same `from`) — computed once here and handed to the bar
  // chart too, so curve and bars line up on the same time axis instead of
  // each independently rounding to its own data range.
  const fileExtent = useMemo(() => {
    const pts = fileSeries.flatMap((s) => windowPoints(s.points, from));
    if (pts.length === 0) return null;
    const t0 = from ?? Math.min(...pts.map((p) => p.t));
    const t1 = Math.max(...pts.map((p) => p.t));
    return { t0, t1 };
  }, [fileSeries, from]);

  // The stat row describes the same slice the charts do — filters scope
  // everything, so the numbers always agree.
  const allDays = useMemo(() => (data?.repos ?? []).flatMap((r) => r.days), [data]);
  const commits = sumSince(allDays, from, (d) => d.commits);
  const filesNet = sumSince(allDays, from, (d) => d.born - d.died);
  const linesNet = sumSince(allDays, from, (d) => d.added - d.removed);
  const windowed = from !== null;

  const months = useMemo(() => {
    const byRepo = (data?.repos ?? []).map((r) => ({
      name: r.name,
      rows: monthlyRollup(r.days),
    }));
    return byRepo.filter((r) => r.rows.length > 0);
  }, [data]);

  return (
    <section className={styles.view} aria-label="How it's grown">
      <TerrainRoomHeader title={<>How it&rsquo;s grown</>} sub="The same system along time — code and vault, accumulating." />

      <div className={styles.windows} role="group" aria-label="Time window">
        {WINDOWS.map((w) => (
          <button
            key={w.label}
            type="button"
            className={[styles.window, days === w.days ? styles.windowOn : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={days === w.days}
            onClick={() => setDays(w.days)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {state === 'loading' ? <p className={styles.note}>Reading the history…</p> : null}
      {state === 'error' ? <p className={styles.note}>Couldn&rsquo;t read the code history.</p> : null}

      {state === 'ready' && data ? (
        <div className={styles.body}>
          {/* The KPI row: value + what it counts. Signed when a window is on,
              because then they're net change, not standing totals. */}
          <div className={styles.stats}>
            <Stat value={compact(commits)} label={windowed ? 'commits' : 'commits, all time'} />
            <Stat
              value={windowed && filesNet >= 0 ? `+${compact(filesNet)}` : compact(filesNet)}
              label={windowed ? 'files, net' : 'files alive'}
            />
            <Stat
              value={windowed && linesNet >= 0 ? `+${compact(linesNet)}` : compact(linesNet)}
              label={windowed ? 'lines, net' : 'lines of code'}
            />
          </div>

          <Legend series={legendSeries} />

          {facets ? (
            <FacetRow facets={facets} lit={lit} litColor={hues.lit} onToggle={toggleLit} />
          ) : null}

          <figure className={styles.figure}>
            <figcaption className={styles.caption}>Files, over time</figcaption>
            <LineChart series={fileSeriesForChart} from={from} dark={dark} ariaLabel="Files over time" />
            {/* The curve's derivative, directly below the curve it came from —
                same window, same x-extent (fileExtent), so the pair reads as
                one object: running total, then the rate that produced it. */}
            <div className={styles.velocityHead}>
              <p className={styles.velocityCaption}>Files born / {binUnit}</p>
              <div className={styles.binToggle} role="group" aria-label="Velocity bar width">
                {BIN_UNITS.map((b) => (
                  <button
                    key={b.unit}
                    type="button"
                    className={[styles.binOption, binUnit === b.unit ? styles.binOptionOn : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={binUnit === b.unit}
                    onClick={() => setBinUnit(b.unit)}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <VelocityChart
              bars={velocityWindowed}
              segments={velocitySegments}
              extent={fileExtent}
              unit={binUnit}
              dark={dark}
              ariaLabel={`Files born per ${binUnit}`}
            />
          </figure>

          <figure className={[styles.figure, lit ? styles.figureDimmed : ''].filter(Boolean).join(' ')}>
            <figcaption className={styles.caption}>Lines of code, over time</figcaption>
            {lit ? <p className={styles.litNote}>Lines don&rsquo;t facet — yet.</p> : null}
            <LineChart series={lineSeries} from={from} dark={dark} ariaLabel="Lines of code over time" />
          </figure>

          {/* Every number the curves show, reachable without a hover — and the
              honest fine print about what git can't count. */}
          <details className={styles.tableFold}>
            <summary className={styles.tableSummary}>As a table, by month</summary>
            {months.map((repo) => (
              <div key={repo.name} className={styles.tableBlock}>
                <h3 className={styles.tableRepo}>{repo.name}</h3>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Month</th>
                      <th scope="col" className={styles.tNum}>
                        commits
                      </th>
                      <th scope="col" className={styles.tNum}>
                        files ±
                      </th>
                      <th scope="col" className={styles.tNum}>
                        files born
                      </th>
                      <th scope="col" className={styles.tNum}>
                        lines ±
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {repo.rows.map((row) => (
                      <tr key={row.month}>
                        <td>{monthLabel(row.month)}</td>
                        <td className={styles.tNum}>{row.commits.toLocaleString('en-US')}</td>
                        <td className={styles.tNum}>{signed(row.files)}</td>
                        <td className={styles.tNum}>{row.born.toLocaleString('en-US')}</td>
                        <td className={styles.tNum}>{signed(row.lines)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <p className={styles.fine}>
              Line counts are what git can count — binary files and merge commits carry none.
            </p>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

/** The identity key both charts share — line-keys (short strokes), because the
 * marks are lines; a filled box would mirror a mark these charts don't have. */
function Legend({ series }: { series: { id: string; label: string; color: string }[] }) {
  return (
    <div className={styles.legend} aria-hidden="true">
      {series.map((s) => (
        <span key={s.id} className={styles.legendItem}>
          <span className={styles.legendKey} style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** One chip, either a place or a front — active state is coloured with the
 * lit hue directly (inline style, not a CSS class) since the colour is
 * data-chosen (validated per theme mode), not a fixed design token. ~40px
 * tall per the house tap-target rule. */
function FacetChip({
  label,
  count,
  active,
  litColor,
  onToggle,
}: {
  label: string;
  count: number;
  active: boolean;
  litColor: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={[styles.facetChip, active ? styles.facetChipActive : ''].filter(Boolean).join(' ')}
      style={
        active
          ? {
              borderColor: litColor,
              background: `color-mix(in srgb, ${litColor} 18%, var(--card-bg))`,
              color: 'var(--text)',
            }
          : undefined
      }
      aria-pressed={active}
      onClick={onToggle}
    >
      {label}
      <span className={styles.facetChipCount}>{count}</span>
    </button>
  );
}

/** The chip row: places (fixed server order, hottest-first) then a divider
 * then fronts, one lit at a time — tap again to unlight. Emphasis, never a
 * filter: nothing here hides anything, it only picks what draws in full
 * strength (see fileSeriesForChart/velocitySegments in TerrainGrowthView). */
function FacetRow({
  facets,
  lit,
  litColor,
  onToggle,
}: {
  facets: GrowthFacets;
  lit: LitFacet | null;
  litColor: string;
  onToggle: (ns: LitFacet['ns'], tag: string) => void;
}) {
  if (facets.places.length === 0 && facets.fronts.length === 0) return null;
  return (
    <div className={styles.facetRow} role="group" aria-label="Highlight a place or subject">
      {facets.places.length > 0 ? (
        <div className={styles.facetGroup}>
          {facets.places.map((p) => (
            <FacetChip
              key={p.id}
              label={p.label}
              count={p.files}
              active={lit?.ns === 'place' && lit.tag === p.id}
              litColor={litColor}
              onToggle={() => onToggle('place', p.id)}
            />
          ))}
        </div>
      ) : null}
      {facets.places.length > 0 && facets.fronts.length > 0 ? <span className={styles.facetDivider} /> : null}
      {facets.fronts.length > 0 ? (
        <div className={styles.facetGroup}>
          {facets.fronts.map((f) => (
            <FacetChip
              key={f.tag}
              label={frontChipLabel(f.tag)}
              count={f.files}
              active={lit?.ns === 'front' && lit.tag === f.tag}
              litColor={litColor}
              onToggle={() => onToggle('front', f.tag)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const CHART_HEIGHT = 220;
const M = { top: 10, right: 84, bottom: 24, left: 6 };

interface Hover {
  t: number;
  x: number;
}

function LineChart({
  series,
  from,
  dark,
  ariaLabel,
}: {
  series: ChartSeries[];
  from: number | null;
  dark: boolean;
  ariaLabel: string;
}) {
  // The chart renders at real pixel size (measured, not viewBox-stretched) so
  // hairlines stay hairlines and text never distorts.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [hover, setHover] = useState<Hover | null>(null);

  const windowed = useMemo(
    () => series.map((s) => ({ ...s, points: windowPoints(s.points, from) })),
    [series, from],
  );

  const allPoints = windowed.flatMap((s) => s.points);
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = CHART_HEIGHT - M.top - M.bottom;

  if (width === 0 || allPoints.length === 0) {
    return (
      <div ref={wrapRef} className={styles.chartWrap}>
        {width > 0 ? <p className={styles.note}>Nothing in this window.</p> : null}
      </div>
    );
  }

  const t0 = from ?? Math.min(...allPoints.map((p) => p.t));
  const t1 = Math.max(...allPoints.map((p) => p.t));
  const vMax = Math.max(...allPoints.map((p) => p.v), 1);
  const ticks = niceTicks(vMax);
  const vTop = ticks[ticks.length - 1];

  const x = (t: number) => M.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * plotW : plotW / 2);
  const y = (v: number) => M.top + plotH - (v / vTop) * plotH;

  const path = (pts: SeriesPoint[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');

  // Direct end labels: the value at each line's end. When the two ends run
  // close, nudge them apart symmetrically — stacked labels detached from
  // their lines read as noise, so the nudge is small and the legend carries
  // whatever it costs.
  const ends = windowed
    .filter((s) => s.points.length > 0)
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return { s, last, ly: y(last.v) };
    });
  if (ends.length === 2 && Math.abs(ends[0].ly - ends[1].ly) < 16) {
    const [a, b] = ends[0].ly <= ends[1].ly ? [ends[0], ends[1]] : [ends[1], ends[0]];
    const mid = (a.ly + b.ly) / 2;
    a.ly = mid - 8;
    b.ly = mid + 8;
  }

  const xTicks = monthTicks(t0, t1);
  const surface = 'var(--bg)';
  const gridStroke = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - M.left) / Math.max(1, plotW)) * (t1 - t0);
    const snapped = nearestTime(
      windowed.map((s) => s.points.map((p) => p.t)),
      Math.max(t0, Math.min(t1, t)),
    );
    if (snapped !== null) setHover({ t: snapped, x: x(snapped) });
  };

  const hoverRows = hover
    ? windowed
        .map((s) => ({ s, v: valueAt(s.points, hover.t) }))
        .filter((r): r is { s: ChartSeries; v: number } => r.v !== null)
    : [];

  return (
    <div ref={wrapRef} className={styles.chartWrap}>
      <svg
        width={width}
        height={CHART_HEIGHT}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* Gridlines: hairline, solid, recessive — with their values riding
            just above, so the axis costs no left margin. */}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} stroke={gridStroke} strokeWidth={1} />
            {v > 0 ? (
              <text x={M.left} y={y(v) - 4} className={styles.tickText}>
                {compact(v)}
              </text>
            ) : null}
          </g>
        ))}
        {xTicks.map((tk) => (
          <text key={tk.t} x={x(tk.t)} y={CHART_HEIGHT - 6} textAnchor="middle" className={styles.tickText}>
            {tk.label}
          </text>
        ))}

        {hover ? (
          <line x1={hover.x} x2={hover.x} y1={M.top} y2={M.top + plotH} className={styles.crosshair} />
        ) : null}

        {/* A dimmed series (the lit overlay's two repo totals) keeps its own
            colour — colour follows entity, this never repaints a line — but
            draws thinner and at reduced opacity, so the lit third line reads
            as the one thing in focus without the totals disappearing. */}
        {windowed.map((s) =>
          s.points.length > 0 ? (
            <path
              key={s.id}
              d={path(s.points)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.dimmed ? 1.5 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={s.dimmed ? 0.4 : 1}
            />
          ) : null,
        )}

        {/* End dots ringed in the surface colour, and the value at the end —
            text in ink, identity from the dot beside it, never coloured text. */}
        {ends.map(({ s, last, ly }) => (
          <g key={s.id} opacity={s.dimmed ? 0.4 : 1}>
            <circle cx={x(last.t)} cy={y(last.v)} r={4} fill={s.color} stroke={surface} strokeWidth={2} />
            <text x={x(last.t) + 10} y={ly + 4} className={styles.endText}>
              {compact(last.v)}
            </text>
          </g>
        ))}
      </svg>

      {hover && hoverRows.length > 0 ? (
        <div
          className={styles.tooltip}
          style={{
            left: Math.min(Math.max(hover.x, 70), Math.max(70, width - 90)),
          }}
        >
          <div className={styles.tooltipDate}>{shortDate(hover.t)}</div>
          {hoverRows.map(({ s, v }) => (
            <div key={s.id} className={styles.tooltipRow}>
              <span className={styles.legendKey} style={{ background: s.color }} />
              <span className={styles.tooltipValue}>{compact(v)}</span>
              <span className={styles.tooltipName}>{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const VELOCITY_HEIGHT = 120;
const BAR_GAP = 2; // surface gap: between stacked segments AND between adjacent bars
const BAR_CAP = 24; // mark spec: bars never fill their slot
// Left/right match the LineChart's M exactly (same plotW → same x-extent in
// pixels, not just in time); top/bottom are its own — this panel draws no
// x-axis labels of its own (the Files chart directly above already carries
// the shared time axis), so it doesn't reserve M's 24px label band.
const BAR_M = { top: 8, right: M.right, bottom: 6, left: M.left };

/**
 * Files-born velocity — stacked bars, one per bin. Reuses the LineChart's
 * tooltip visual language (same CSS classes) rather than inventing a second
 * one, and takes its x-extent as a prop instead of computing it, so this
 * chart's time axis lines up pixel-for-pixel with the Files curve above it
 * (see TerrainGrowthView's `fileExtent`).
 */
function VelocityChart({
  bars,
  segments,
  extent,
  unit,
  dark,
  ariaLabel,
}: {
  bars: VelocityBar[];
  segments: VelocitySegment[];
  extent: { t0: number; t1: number } | null;
  unit: BinUnit;
  dark: boolean;
  ariaLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const plotW = Math.max(0, width - BAR_M.left - BAR_M.right);
  const plotH = VELOCITY_HEIGHT - BAR_M.top - BAR_M.bottom;

  if (width === 0 || !extent || bars.length === 0) {
    return (
      <div ref={wrapRef} className={styles.chartWrap}>
        {width > 0 && extent ? <p className={styles.note}>Nothing in this window.</p> : null}
      </div>
    );
  }

  const { t0, t1 } = extent;
  const x = (t: number) => BAR_M.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * plotW : plotW / 2);

  const totals = bars.map((b) => segments.reduce((sum, s) => sum + (b.values[s.id] ?? 0), 0));
  const vMax = Math.max(...totals, 1);
  const ticks = niceTicks(vMax);
  const vTop = ticks[ticks.length - 1];
  const y = (v: number) => BAR_M.top + plotH - (v / vTop) * plotH;
  const baseline = BAR_M.top + plotH;

  // A bin's nominal width in pixels, from its duration mapped through the
  // same linear time scale as its position — bins are equal-length except
  // month (28-31 days), a difference invisible at chart scale. The painted
  // bar is capped and centered inside this slot; the slot itself (not the
  // capped bar) is the hover/focus hit target, per the skill's "hit area
  // at least as wide as the mark's column" rule.
  const unitSeconds = unit === 'day' ? 86400 : unit === 'week' ? 7 * 86400 : 30 * 86400;
  const slotW = Math.max(1, (unitSeconds / Math.max(1, t1 - t0)) * plotW);
  const barW = Math.min(BAR_CAP, Math.max(1, slotW - BAR_GAP));

  const gridStroke = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';

  const hoverBar = hoverIdx !== null ? bars[hoverIdx] : null;
  const hoverTotal = hoverBar ? segments.reduce((sum, s) => sum + (hoverBar.values[s.id] ?? 0), 0) : 0;
  const hoverX = hoverBar ? x(hoverBar.t) + slotW / 2 : 0;

  return (
    <div ref={wrapRef} className={styles.chartWrap}>
      <svg width={width} height={VELOCITY_HEIGHT} role="img" aria-label={ariaLabel}>
        {/* Gridlines: hairline, solid, recessive, y-axis anchored at zero —
            same treatment as the LineChart above it. */}
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={BAR_M.left}
              x2={BAR_M.left + plotW}
              y1={y(v)}
              y2={y(v)}
              stroke={gridStroke}
              strokeWidth={1}
            />
            {v > 0 ? (
              <text x={BAR_M.left} y={y(v) - 4} className={styles.tickText}>
                {compact(v)}
              </text>
            ) : null}
          </g>
        ))}

        {bars.map((bar, i) => {
          const slotX = x(bar.t);
          const barX = slotX + (slotW - barW) / 2;
          const nonZero = segments.filter((s) => (bar.values[s.id] ?? 0) > 0);
          let cursorY = baseline;
          return (
            <g key={bar.t}>
              {hoverIdx === i ? (
                <rect
                  x={slotX}
                  y={BAR_M.top}
                  width={slotW}
                  height={plotH}
                  fill="color-mix(in srgb, var(--text) 6%, transparent)"
                />
              ) : null}
              {/* Stack bottom-up so the entity order matches the legend;
                  every segment squares off at the baseline, only the one
                  that ends up on top gets the mark spec's rounded cap; a
                  2px surface gap separates touching segments. */}
              {nonZero.map((s, si) => {
                const v = bar.values[s.id] ?? 0;
                const h = (v / vTop) * plotH;
                const segTop = cursorY - h;
                const isTop = si === nonZero.length - 1;
                cursorY = segTop - BAR_GAP;
                return isTop ? (
                  <path key={s.id} d={roundedTopRectPath(barX, segTop, barW, h, 4)} fill={s.color} />
                ) : (
                  <rect key={s.id} x={barX} y={segTop} width={barW} height={h} fill={s.color} />
                );
              })}
              {/* Hit target: the whole bin column (slotW), not the thinner
                  painted bar — a thin bar over 90+ columns is otherwise a
                  pinpoint nobody lands on. */}
              <rect
                x={slotX}
                y={BAR_M.top}
                width={slotW}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${bar.label}: ${segments
                  .map((s) => `${s.label} ${compact(bar.values[s.id] ?? 0)}`)
                  .join(', ')}, ${compact(totals[i])} total`}
                onPointerEnter={() => setHoverIdx(i)}
                onPointerLeave={() => setHoverIdx((h) => (h === i ? null : h))}
                onFocus={() => setHoverIdx(i)}
                onBlur={() => setHoverIdx((h) => (h === i ? null : h))}
              />
            </g>
          );
        })}
      </svg>

      {hoverBar ? (
        <div
          className={styles.tooltip}
          style={{ left: Math.min(Math.max(hoverX, 70), Math.max(70, width - 90)) }}
        >
          <div className={styles.tooltipDate}>{hoverBar.label}</div>
          {segments.map((s) => (
            <div key={s.id} className={styles.tooltipRow}>
              <span className={styles.legendKey} style={{ background: s.color }} />
              <span className={styles.tooltipValue}>{compact(hoverBar.values[s.id] ?? 0)}</span>
              <span className={styles.tooltipName}>{s.label}</span>
            </div>
          ))}
          <div className={styles.tooltipRow}>
            <span className={styles.tooltipValue}>{compact(hoverTotal)}</span>
            <span className={styles.tooltipName}>total</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A rect path rounded only at the top two corners, square at the baseline —
 * the bar mark spec ("4px rounded data-end, square at the baseline")
 * applied to whichever stacked segment ends up on top. */
function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (rr <= 0) return `M${x},${y + h} L${x},${y} L${x + w},${y} L${x + w},${y + h} Z`;
  return [
    `M${x},${y + h}`,
    `L${x},${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `L${x + w - rr},${y}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `L${x + w},${y + h}`,
    'Z',
  ].join(' ');
}
