import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from '../../ui';
import { subscribeTheme } from '../../theme';
import { useAtlas } from '../atlas/api';
import { useTerrain, type TerrainData } from './api';
import type { TerrainNode } from './terrainGraph';
import {
  buildTerrainGraph,
  changedFileIds,
  fileLastTouch,
  filterTerrainData,
  relativeAge,
  sessionFootprint,
  sessionLastSeconds,
  terrainEarliestTouch,
  terrainFileLoaded,
  terrainFileTotal,
  SESSION_NODE_PREFIX,
  HEAT_LENSES,
  type HeatLens,
} from './terrainGraph';
import { TerrainDials } from './TerrainDials';
import { FileCodeModal } from './FileCodeModal';
import {
  deriveOrbColor,
  readThemeInk,
  TerrainCanvas,
  HEAT_RAMP_DARK,
  HEAT_RAMP_LIGHT,
  type ThemeInk,
} from './terrainCanvas';
import styles from './TerrainPage.module.css';

const LENS_LABELS: Record<HeatLens, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

/** Age ticks for the color key, top (hottest) → bottom (oldest), per lens. */
const KEY_TICKS: Record<HeatLens, readonly string[]> = {
  day: ['now', '6h', '1d+'],
  week: ['now', '1d', '1w+'],
  month: ['now', '1w', '30d+'],
};

/**
 * The color key — a compact panel pinned to the canvas's bottom-right whose
 * whole job is explaining the colors: the terminal-red heat ramp (just
 * edited #f14c4c at the top, down through #cd3131 to black = old) with age
 * ticks that follow the active lens, plus one row decoding the session-orb
 * ring. pointer-events: none throughout — pan/zoom passes straight through;
 * it hides while the sheet is up so it never fights the modal.
 */
function TerrainKey({
  lens,
  ink,
  hidden,
  showAgents,
}: {
  lens: HeatLens;
  ink: ThemeInk;
  hidden: boolean;
  /** Drops the orb row from the key when the agents are toggled off — a
   * legend shouldn't decode something that isn't on the map. */
  showAgents: boolean;
}) {
  const ramp = ink.dark ? HEAT_RAMP_DARK : HEAT_RAMP_LIGHT;
  const gradient = `linear-gradient(to bottom, ${[...ramp].reverse().join(', ')})`;
  const orb = deriveOrbColor(ink.accent, ink.evening, ink.bg, ink.text);
  return (
    <div
      className={[styles.key, hidden ? styles.keyHidden : ''].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <div className={styles.keyScale}>
        <div className={styles.keyBar} style={{ background: gradient }} />
        <div className={styles.keyTicks}>
          {KEY_TICKS[lens].map((tick) => (
            <span key={tick} className={styles.keyTick}>
              {tick}
            </span>
          ))}
        </div>
      </div>
      {showAgents ? (
        <div className={styles.keySessionRow}>
          <span className={styles.keyRing} style={{ borderColor: orb }} />
          {/* "agent", matching the bottom bar's toggle — one word for the orbs
              across the whole surface rather than two for the same thing. */}
          <span className={styles.keyTick}>agent</span>
        </div>
      ) : null}
    </div>
  );
}

/** "2h" → "2h ago", but "now" stays "just now" (never "now ago"). */
function agoPhrase(unixSeconds: number): string {
  const age = relativeAge(unixSeconds);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** Live document visibility — gates the ~5s poll (and, inside the engine,
 * the orb pulse) so a backgrounded PWA never burns battery watching itself. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * /terrain — "where is being worked on": every file the reading room's
 * sessions touched in the window, as a force-directed tree per repo (App
 * code / Vault), files glowing ember by recency. The heat lens chips pick
 * the half-life (Day 24h / Week 7d / Month 30d, Week default); repo chips
 * toggle each subtree. Tap a file → bottom sheet with its sessions; each
 * session row opens that conversation exactly like the atlas does, or rings
 * its whole footprint on the map. All rendering lives in terrainCanvas.ts;
 * all graph/heat math in terrainGraph.ts (tested).
 */
const DAY_SECONDS = 86400;

/**
 * How many files per repo to ask the server for, escalating as the Files
 * dial climbs. Tiers rather than the exact count so a drag doesn't fire a
 * request per pixel: within a tier the dial slices locally (instant), and
 * only crossing one costs a fetch — which react-query then caches, so
 * sliding back down is instant too. `null` = every file there is.
 */
const FETCH_TIERS: readonly (number | null)[] = [350, 1000, 2500, null];

function nextTier(tier: number | null): number | null {
  if (tier === null) return null;
  const i = FETCH_TIERS.indexOf(tier);
  return i === -1 || i === FETCH_TIERS.length - 1 ? null : FETCH_TIERS[i + 1];
}

/** Debounce a fast-changing value (a dragging slider) down to something worth
 * reacting to. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function TerrainPage() {
  const navigate = useNavigate();
  const pageVisible = usePageVisible();
  // Live mode: while any payload session is running AND the page is visible,
  // poll ~5s so a working session's touches light up as they happen. The
  // flag comes from the last payload, so the first fetch always runs cold
  // and the poll turns itself off when the last session goes quiet.
  const [anyRunning, setAnyRunning] = useState(false);
  const [tier, setTier] = useState<number | null>(FETCH_TIERS[0]);
  const { data, isLoading, isError, isFetching } = useTerrain(anyRunning && pageVisible, tier);
  useEffect(() => {
    if (data) setAnyRunning((data.sessions ?? []).some((s) => s.running));
  }, [data]);
  // File-level sessions carry no bot id; the top-level sessions array does
  // (new contract). The cached atlas fetch stays as the fallback map for
  // sessions the array doesn't know.
  const atlas = useAtlas();

  const [lens, setLens] = useState<HeatLens>('week');
  const [hiddenRepos, setHiddenRepos] = useState<ReadonlySet<string>>(new Set());
  // Session orbs — the agents that have been working in here. On by default;
  // toggled off when you want the territory without the bodies standing on it.
  const [showAgents, setShowAgents] = useState(true);
  const [selected, setSelected] = useState<TerrainNode | null>(null);
  const [footprintSession, setFootprintSession] = useState<string | null>(null);
  // The file whose code modal is open, if any. Kept separate from `selected`
  // so closing the code view drops back to the file's session sheet rather
  // than dismissing everything.
  const [codeFile, setCodeFile] = useState<{
    repo: string;
    path: string;
  } | null>(null);

  // --- the two dials -----------------------------------------------------
  // How many file nodes to draw. null until the first payload tells us how
  // many there are, then defaults to everything the first tier loaded.
  const [count, setCount] = useState<number | null>(null);
  // The date span, and the only time control there is. null = the full range
  // (earliest touch → now), which is also the default view.
  const [customRange, setCustomRange] = useState<{
    from: number;
    to: number;
  } | null>(null);

  // "Now" comes off the payload, not the wall clock, so it only advances when
  // fresh data arrives — a live-polling map doesn't jitter its own date range
  // between renders.
  const now = useMemo(() => {
    const stamped = data ? Date.parse(data.generated_at) : NaN;
    return Number.isFinite(stamped) ? stamped / 1000 : Date.now() / 1000;
  }, [data]);

  const earliest = useMemo(
    () => (data ? terrainEarliestTouch(data, now) : now - 90 * DAY_SECONDS),
    [data, now],
  );
  const totalFiles = useMemo(() => (data ? terrainFileTotal(data) : 0), [data]);
  const loadedFiles = useMemo(() => (data ? terrainFileLoaded(data) : 0), [data]);

  // First payload seeds the count dial at "everything currently loaded".
  useEffect(() => {
    if (count === null && loadedFiles > 0) setCount(loadedFiles);
  }, [count, loadedFiles]);

  const effectiveCount = count ?? loadedFiles;
  // Unpinned, the range is simply everything the payload covers.
  const range = useMemo(
    () => customRange ?? { from: earliest, to: now },
    [customRange, earliest, now],
  );

  // Escalate the fetch tier when she asks for more files than the payload
  // holds. Debounced, so a drag from 350 to "all" costs one request, not one
  // per tier crossed on the way.
  const settledCount = useDebounced(effectiveCount, 350);
  useEffect(() => {
    if (!data) return;
    if (settledCount > loadedFiles && loadedFiles < totalFiles) {
      setTier((cur) => nextTier(cur));
    }
  }, [settledCount, loadedFiles, totalFiles, data]);
  // Live theme tokens for the HTML color key (the engine keeps its own copy)
  // — set on mount and kept fresh by the same subscription below.
  const [ink, setInk] = useState<ThemeInk | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TerrainCanvas | null>(null);
  const fittedRef = useRef(false);

  // The dials narrow the payload first (time, then count), and the graph is
  // built from what survives — so heat, ages and session lists all describe
  // the chosen span rather than all time.
  const filtered = useMemo(
    () =>
      data ? filterTerrainData(data, { from: range.from, to: range.to, count: effectiveCount }, now) : null,
    [data, range.from, range.to, effectiveCount, now],
  );

  const graph = useMemo(() => (filtered ? buildTerrainGraph(filtered, lens) : null), [filtered, lens]);

  // What's actually drawn — the honest numerator for the Files readout.
  const shownFiles = useMemo(() => (filtered ? terrainFileLoaded(filtered) : 0), [filtered]);

  /** How many agent orbs the current view would carry — drives the chip's
   * count, and hides the chip entirely when nobody has been through here. */
  const agentCount = useMemo(
    () => (graph ? graph.nodes.filter((n) => n.kind === 'session').length : 0),
    [graph],
  );

  const visible = useMemo(() => {
    if (!graph) return null;
    // Orbs carry repoId '' so the repo chips never touch them — they roam
    // across both territories. The Agents chip is what governs them.
    const nodes = graph.nodes.filter(
      (n) => !hiddenRepos.has(n.repoId) && (showAgents || n.kind !== 'session'),
    );
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges };
  }, [graph, hiddenRepos, showAgents]);

  // Hiding the agents must also drop any orb-specific state hanging off them,
  // or the sheet would keep describing a body that's no longer on the map.
  useEffect(() => {
    if (showAgents) return;
    setSelected((cur) => (cur?.kind === 'session' ? null : cur));
    setFootprintSession(null);
  }, [showAgents]);

  const convToBot = useMemo(() => {
    const map = new Map<string, string>();
    // Atlas first (fallback layer), then the terrain payload's own sessions
    // array on top — the terrain contract is authoritative where it knows.
    for (const s of atlas.data?.sessions ?? []) map.set(s.id, s.bot);
    for (const s of data?.sessions ?? []) if (s.bot) map.set(s.id, s.bot);
    return map;
  }, [atlas.data, data?.sessions]);

  // "Nothing here" is now a statement about the chosen dials, not just the
  // payload — narrowing to a quiet week should say so rather than look broken.
  const empty = filtered !== null && filtered.repos.every((r) => r.files.length === 0);
  const emptyBecauseFiltered = empty && data !== undefined && terrainFileLoaded(data) > 0;

  // Engine lifecycle — one instance per mount, sized by ResizeObserver.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const initialInk = readThemeInk();
    const engine = new TerrainCanvas(canvas, initialInk);
    engineRef.current = engine;
    setInk(initialInk);
    engine.resize(wrap.clientWidth, wrap.clientHeight);

    const ro = new ResizeObserver(() => engine.resize(wrap.clientWidth, wrap.clientHeight));
    ro.observe(wrap);

    // Repaint (canvas + HTML key) on theme commits; a slow recheck covers
    // the sky engine's silent 2-minute phase drifts (usageHeat.ts pattern).
    const applyTheme = () => {
      const t = readThemeInk();
      engine.setTheme(t);
      setInk(t);
    };
    const unsubscribe = subscribeTheme(applyTheme);
    const themeTimer = window.setInterval(applyTheme, 60_000);

    return () => {
      ro.disconnect();
      unsubscribe();
      window.clearInterval(themeTimer);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Tap → sheet. Files open their session list; a session orb highlights
  // its footprint immediately AND opens its sheet; empty canvas clears both.
  // (Repo/dir hubs are structure, not destinations — taps pass through.)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.onTap = (node) => {
      if (node?.kind === 'file') {
        setSelected(node);
      } else if (node?.kind === 'session' && node.session) {
        setSelected(node);
        setFootprintSession(node.session.id);
      } else if (node === null) {
        setSelected(null);
        setFootprintSession(null);
      }
    };
  });

  // Keep the engine's selection in sync — idle orbs label only while tapped.
  useEffect(() => {
    engineRef.current?.setSelected(selected?.id ?? null);
  }, [selected]);

  // Live-mode flashes: any file whose newest touch advanced since the
  // previous payload glows for a second — the "watch it work" effect.
  const prevDataRef = useRef<TerrainData | null>(null);
  useEffect(() => {
    if (!data) return;
    const prev = prevDataRef.current;
    prevDataRef.current = data;
    if (!prev) return;
    const changed = changedFileIds(prev, data);
    if (changed.size > 0) engineRef.current?.flash(changed);
  }, [data]);

  // Data / lens / repo-visibility changes re-feed the sim (positions carry
  // over inside setGraph, so this re-warms rather than re-explodes).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !visible) return;
    engine.setGraph(visible.nodes, visible.edges);
    if (!fittedRef.current && visible.nodes.length > 0) {
      fittedRef.current = true;
      engine.fitSoon();
    }
  }, [visible]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !visible) return;
    if (!footprintSession) {
      engine.setFootprint(null);
      return;
    }
    // The session's files plus its own orb — the orb stays lit while its
    // territory is ringed and everything else dims.
    const ids = sessionFootprint(visible.nodes, footprintSession);
    ids.add(`${SESSION_NODE_PREFIX}${footprintSession}`);
    engine.setFootprint(ids);
  }, [footprintSession, visible]);

  const toggleRepo = (repoId: string) => {
    setHiddenRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  const openSession = (convId: string) => {
    // Same destination the atlas's cards use (RosterPage.open). Bot comes
    // from the terrain payload's sessions array when it knows the session,
    // else the atlas conv→bot map, else 'keeper' (v1 single-engine).
    const botId = convToBot.get(convId) ?? 'keeper';
    void navigate({
      to: '/reading-room/$botId',
      params: { botId },
      search: { conv: convId },
    });
  };

  const selectedLast = selected?.file ? fileLastTouch(selected.file) : null;

  return (
    <div className={styles.page}>
      {/* Canvas first and full-bleed: the chrome below floats over it, so the
          map owns the whole page and shows through the controls. */}
      <div ref={wrapRef} className={styles.canvasWrap}>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="File-tree heatmap" />
        {isLoading ? <div className={styles.overlayHint}>Loading the terrain…</div> : null}
        {isError ? <div className={styles.overlayHint}>Couldn&rsquo;t load the terrain.</div> : null}
        {empty ? (
          <div className={styles.overlayHint}>
            {emptyBecauseFiltered
              ? 'Nothing was touched in this date range — widen it to see more.'
              : 'Nothing touched in the window yet.'}
          </div>
        ) : null}
        {ink && !empty && !isLoading && !isError ? (
          <TerrainKey lens={lens} ink={ink} hidden={selected !== null} showAgents={showAgents} />
        ) : null}
      </div>

      <div className={styles.chrome}>
        <div className={styles.topBar}>
          <h1 className={styles.title}>Terrain</h1>
          <div className={styles.chipRow} role="group" aria-label="Heat half-life">
            {HEAT_LENSES.map((l) => (
              <button
                key={l}
                type="button"
                className={[styles.chip, lens === l ? styles.chipActive : ''].filter(Boolean).join(' ')}
                aria-pressed={lens === l}
                onClick={() => setLens(l)}
              >
                {LENS_LABELS[l]}
              </button>
            ))}
          </div>
          {footprintSession ? (
            <button
              type="button"
              className={[styles.chip, styles.footprintChip].join(' ')}
              onClick={() => setFootprintSession(null)}
            >
              footprint · clear ×
            </button>
          ) : null}
          {customRange ? (
            <button
              type="button"
              className={[styles.chip, styles.footprintChip].join(' ')}
              onClick={() => setCustomRange(null)}
            >
              dates · clear ×
            </button>
          ) : null}
        </div>

        {data ? (
          <TerrainDials
            shown={shownFiles}
            totalFiles={totalFiles}
            count={effectiveCount}
            onCount={setCount}
            loadingMore={isFetching && effectiveCount > loadedFiles}
            earliest={earliest}
            now={now}
            from={range.from}
            to={range.to}
            onRange={(from, to) => setCustomRange({ from, to })}
          />
        ) : null}
      </div>

      {/* What's ON the map (which territories, whose orbs) lives at the
          bottom, away from the dials that control how much of it you see.
          Left-anchored so it never runs under the colour key at bottom-right. */}
      <div className={styles.chromeBottom}>
        <div className={styles.chipRow} role="group" aria-label="What to show">
          {(data?.repos ?? []).map((repo) => (
            <button
              key={repo.id}
              type="button"
              className={[styles.chip, styles.repoChip, hiddenRepos.has(repo.id) ? styles.chipOff : '']
                .filter(Boolean)
                .join(' ')}
              aria-pressed={!hiddenRepos.has(repo.id)}
              onClick={() => toggleRepo(repo.id)}
            >
              {repo.name}
            </button>
          ))}
          {agentCount > 0 ? (
            <button
              type="button"
              // Either/or, not both: .agentChip is declared after .chipOff, so
              // applying them together would let the "on" tint win over the
              // hollow "off" look at equal specificity.
              className={[styles.chip, showAgents ? styles.agentChip : styles.chipOff]
                .filter(Boolean)
                .join(' ')}
              aria-pressed={showAgents}
              onClick={() => setShowAgents((v) => !v)}
              title={showAgents ? 'Hide the agents working on this' : 'Show the agents working on this'}
            >
              Agents · {agentCount}
            </button>
          ) : null}
        </div>
      </div>

      <Sheet open={selected !== null} title={selected?.label} onClose={() => setSelected(null)}>
        {selected?.kind === 'session' && selected.session ? (
          <div className={styles.sheetBody}>
            <div className={styles.sheetMeta}>
              {selected.session.running ? (
                <span className={styles.runningBadge}>
                  <span className={styles.runningDot} aria-hidden="true" /> running
                </span>
              ) : null}
              {selected.session.last !== null
                ? `${selected.session.running ? ' · ' : ''}last activity ${agoPhrase(selected.session.last)}`
                : null}
              {' · '}
              {selected.session.files} {selected.session.files === 1 ? 'file' : 'files'} in footprint
            </div>
            <div className={styles.sessionList}>
              <button
                type="button"
                className={styles.sessionOpen}
                onClick={() => openSession(selected.session!.id)}
              >
                <span className={styles.sessionTitle}>Open conversation</span>
                <span className={styles.sessionMeta}>{selected.session.title}</span>
              </button>
            </div>
            <div className={styles.sheetMeta}>
              Its footprint is ringed on the map — tap elsewhere to clear.
            </div>
          </div>
        ) : null}
        {selected?.file ? (
          <div className={styles.sheetBody}>
            <div className={styles.sheetPath}>{selected.path}</div>
            <div className={styles.sheetMeta}>
              {selectedLast !== null ? `last touched ${agoPhrase(selectedLast)}` : 'no touches in window'}
              {' · '}
              {selected.file.touches.length} {selected.file.touches.length === 1 ? 'touch' : 'touches'}
            </div>
            <button
              type="button"
              className={styles.viewCodeBtn}
              onClick={() => {
                if (selected.path) setCodeFile({ repo: selected.repoId, path: selected.path });
              }}
            >
              View the code
            </button>
            {selected.file.sessions.length > 0 ? (
              <div className={styles.sessionList}>
                {selected.file.sessions.map((s) => (
                  <div key={s.id} className={styles.sessionRow}>
                    <button type="button" className={styles.sessionOpen} onClick={() => openSession(s.id)}>
                      <span className={styles.sessionTitle}>{s.title || s.id}</span>
                      <span className={styles.sessionMeta}>
                        {s.writes} {s.writes === 1 ? 'write' : 'writes'}
                        {/* ISO string in the payload, not unix seconds — fed
                            through raw this rendered a literal "NaNmo ago". */}
                        {sessionLastSeconds(s.last) !== null
                          ? ` · ${agoPhrase(sessionLastSeconds(s.last)!)}`
                          : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={[styles.footprintBtn, footprintSession === s.id ? styles.footprintBtnOn : '']
                        .filter(Boolean)
                        .join(' ')}
                      aria-pressed={footprintSession === s.id}
                      title="Show this session's footprint on the map"
                      onClick={() => {
                        setFootprintSession((cur) => (cur === s.id ? null : s.id));
                        setSelected(null);
                      }}
                    >
                      footprint
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.sheetMeta}>No sessions recorded for this file.</div>
            )}
          </div>
        ) : null}
      </Sheet>

      {/* Portalled over the canvas — the sim, the zoom transform and the
          layout are all untouched while it's up, so closing it drops you back
          onto exactly the map you left. */}
      <FileCodeModal
        repo={codeFile?.repo ?? null}
        path={codeFile?.path ?? null}
        onClose={() => setCodeFile(null)}
      />
    </div>
  );
}
