import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { readThemeInk } from './terrainCanvas';
import {
  compact,
  cumulative,
  monthLabel,
  monthTicks,
  monthlyRollup,
  nearestTime,
  niceTicks,
  shortDate,
  sumSince,
  valueAt,
  velocityBars,
  velocityBinUnit,
  windowBars,
  windowPoints,
  type BinUnit,
  type GrowthData,
  type SeriesPoint,
  type VelocityBar,
} from './growthMath';
import styles from './TerrainGrowthView.module.css';

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
 *   colour.
 * - **Marks per spec:** 2px round-capped lines, ≥8px end dots ringed in the
 *   surface colour, hairline solid gridlines, y-axis always anchored at zero —
 *   a growth curve read against a clipped baseline is the classic chart lie.
 * - **The hover layer is part of the chart:** a crosshair that snaps to the
 *   nearest recorded day, one tooltip listing BOTH series (value leads, name
 *   follows, line-key strokes) — and nothing gates on it, because the table
 *   view holds every number reachable by tap.
 * - **The velocity panel is the Files curve's derivative, so it sits directly
 *   under it and shares its window control and x-extent** — the curve reads
 *   as the running total, the bars directly below as the rate that produced
 *   it, one object read top to bottom. Part-to-whole per bin (skeleton vs
 *   vault) is a stacked bar, same categorical pair and legend as the curve
 *   above it (one legend already names both series — a second box under the
 *   bars would just repeat it). Stack segments are built from `fileSeries`
 *   generically (an array, not two hardcoded fields), so a later facet that
 *   splits a bar into more slices is more rows, not a rewrite. Bin width
 *   widens with the window (growthMath.velocityBinUnit) so a bar never goes
 *   thinner than the eye can resolve, and the panel title says which unit is
 *   live ("files born / day|week|month") rather than leaving it implicit.
 *
 * Prompt that produced this file: "I want it to be able to let me build more
 * UI like terrain and make visualizations of my entire codebase/file system
 * as it grows." Prompt that added the velocity panel: "in the growth charts
 * show the velocity of files being created — how many files are generated on
 * a given day, as bars."
 */

const WINDOWS: readonly { days: number | null; label: string }[] = [
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: null, label: 'All' },
];

/** Series colours per theme mode — the validated pairs (see the docblock).
 * The indigo is the theme's own `evening` accent; the amber is `morning`,
 * darkened one step in dark mode to sit inside the validator's band. */
const HUES = {
  light: { skeleton: '#6a7acc', vault: '#d4880a' },
  dark: { skeleton: '#6a7acc', vault: '#c8820c' },
} as const;

interface ChartSeries {
  id: string;
  label: string;
  color: string;
  points: SeriesPoint[]; // full-history cumulative; windowed inside the chart
}

export function TerrainGrowthView() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [days, setDays] = useState<number | null>(null); // All — growth is the long story
  const dark = useMemo(() => readThemeInk().dark, []);
  const hues = dark ? HUES.dark : HUES.light;

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

  // The velocity panel: files-BORN binned wide enough to read at this
  // window (day/week/month — growthMath.velocityBinUnit), over ALL history
  // like the curves above, sliced to the window afterwards.
  const binUnit = velocityBinUnit(days);
  const velocity = useMemo(
    () => velocityBars((data?.repos ?? []).map((r) => ({ id: r.id, days: r.days })), binUnit),
    [data, binUnit],
  );
  const velocityWindowed = useMemo(() => windowBars(velocity, from), [velocity, from]);

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
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>How it&rsquo;s grown</h2>
          <p className={styles.sub}>The same system along time — code and vault, accumulating.</p>
        </div>
        <Link to="/terrain/map" className={styles.back} aria-label="Back to the terrain map">
          ← Terrain
        </Link>
      </header>

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

          <Legend series={fileSeries} />

          <figure className={styles.figure}>
            <figcaption className={styles.caption}>Files, over time</figcaption>
            <LineChart series={fileSeries} from={from} dark={dark} ariaLabel="Files over time" />
            {/* The curve's derivative, directly below the curve it came from —
                same window, same x-extent (fileExtent), so the pair reads as
                one object: running total, then the rate that produced it. */}
            <p className={styles.velocityCaption}>Files born / {binUnit}</p>
            <VelocityChart
              bars={velocityWindowed}
              segments={fileSeries}
              extent={fileExtent}
              unit={binUnit}
              dark={dark}
              ariaLabel={`Files born per ${binUnit}`}
            />
          </figure>

          <figure className={styles.figure}>
            <figcaption className={styles.caption}>Lines of code, over time</figcaption>
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
function Legend({ series }: { series: ChartSeries[] }) {
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

        {windowed.map((s) =>
          s.points.length > 0 ? (
            <path
              key={s.id}
              d={path(s.points)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null,
        )}

        {/* End dots ringed in the surface colour, and the value at the end —
            text in ink, identity from the dot beside it, never coloured text. */}
        {ends.map(({ s, last, ly }) => (
          <g key={s.id}>
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

/** The generic shape a stacked segment needs — deliberately just id/label/
 * color, not tied to "repo": today `segments` is `fileSeries` (two repos),
 * but any list of this shape stacks, so a later facet (e.g. by vault place)
 * is a longer list here, not a new render path. */
interface VelocitySegment {
  id: string;
  label: string;
  color: string;
}

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
