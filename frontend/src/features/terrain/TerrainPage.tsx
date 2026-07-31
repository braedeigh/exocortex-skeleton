import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from '../../ui';
import { subscribeTheme } from '../../theme';
import { openConversationInPane } from '../../shell/paneConversation';
import { useAtlas } from '../atlas/api';
import { useSessionPreview, useSessionRoster } from '../observatory/api';
import { isUnread, openedMap } from '../observatory/openedStore';
import { useTerrain, type TerrainData } from './api';
import type { FileTouchKind, TerrainNode } from './terrainGraph';
import {
  agentTouchRings,
  breathHalfLife,
  BREATH_INHALE_FRACTION,
  buildTerrainGraph,
  changedFileIds,
  BREATH_PERIOD_MS,
  BREATH_TICK_MS,
  fileLastTouch,
  filterTerrainData,
  relativeAge,
  sessionFootprint,
  sessionFootprintByRecency,
  sessionLastSeconds,
  terrainEarliestTouch,
  terrainFileLoaded,
  terrainFileTotal,
  heatKeyTicks,
  SESSION_NODE_PREFIX,
} from './terrainGraph';
import { TerrainDials } from './TerrainDials';
import { TerrainHeatBar } from './TerrainHeatBar';
import type { AgentPool, AgentSection } from './TerrainAgentBar';
import { TerrainAgentBar } from './TerrainAgentBar';
import { FileCodeWindow } from './FileCodeWindow';
import { AgentHoverCard } from './AgentHoverCard';
import {
  readThemeInk,
  TerrainCanvas,
  HEAT_RAMP_DARK,
  HEAT_RAMP_LIGHT,
  type AgentHover,
  type ThemeInk,
} from './terrainCanvas';
import styles from './TerrainPage.module.css';

/**
 * The color key — a compact panel pinned to the canvas's bottom-right whose
 * whole job is explaining the colors: the terminal-red heat ramp (just
 * edited #f14c4c at the top, down through #cd3131 to black = old) with age
 * ticks generated from the heat bar's current half-life, plus one row
 * decoding the session-orb ring. pointer-events: none throughout — pan/zoom
 * passes straight through; it hides while the sheet is up so it never fights
 * the modal.
 */
function TerrainKey({
  halfLife,
  ink,
  hidden,
  showAgents,
}: {
  /** Half-life in seconds — the ticks are derived from it (heatKeyTicks), not
   * looked up from a fixed set, because the bar is continuous now. */
  halfLife: number;
  ink: ThemeInk;
  hidden: boolean;
  /** Drops the orb row from the key when the agents are toggled off — a
   * legend shouldn't decode something that isn't on the map. */
  showAgents: boolean;
}) {
  const ramp = ink.dark ? HEAT_RAMP_DARK : HEAT_RAMP_LIGHT;
  const gradient = `linear-gradient(to bottom, ${[...ramp].reverse().join(', ')})`;
  const orb = ink.accent; // agents (and their tethers) wear the app --accent — matches the engine
  return (
    <div
      className={[styles.key, hidden ? styles.keyHidden : ''].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <div className={styles.keyScale}>
        <div className={styles.keyBar} style={{ background: gradient }} />
        <div className={styles.keyTicks}>
          {heatKeyTicks(halfLife).map((tick) => (
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
 * /terrain — "where is being worked on": every file the observatory's
 * sessions touched in the window, as a force-directed tree per repo (App
 * code / Vault), files glowing ember by recency.
 *
 * The chrome splits by what it governs. TOP: how much map to draw — the repo
 * chips (which territories) and the Files / Dates dials. BOTTOM: how it's lit
 * and who's on it — the Heat bar over the agent bar, since lighting is the
 * outer question and the roster reads as nested under it. Heat is a continuous
 * half-life in days (7 by default), not the three named lenses it replaced,
 * and its Dynamic preset hands that half-life to the Observatory backdrop's
 * breath so the whole map remembers further back and forgets again on a ten
 * second cycle.
 *
 * Tap a file → its code, in a frosted window floating over the map
 * (FileCodeWindow), with what the map knows about the file printed under it:
 * when it was last touched, and every agent that touched it — each row opens
 * that conversation exactly like the atlas does, or rings its whole footprint
 * on the map. Tap an agent orb → a sheet, and its footprint rings at once.
 *
 * HOVER an agent orb (mouse only) and its session card floats up beside it —
 * summary, last thing said, what it's waiting on (AgentHoverCard). That needs
 * facts the terrain payload doesn't carry, so this page also reads the
 * Observatory roster and, per hover, one small last-line fetch.
 *
 * All rendering lives in terrainCanvas.ts; all graph/heat math in
 * terrainGraph.ts (tested).
 */
const DAY_SECONDS = 86400;

/** What "Active" means: did something within the last hour. A real cliff — an
 * agent quiet for 61 minutes drops out — but a live map wants a short memory,
 * and the Open pool is right there for the wider view. */
const ACTIVE_WINDOW_SECONDS = 3600;

/** How long the cursor has to rest on an orb before its hovercard appears.
 * Sweeping across a cluster of agents shouldn't strobe cards; once one IS up,
 * moving to the next orb swaps instantly (the pause has already been paid). */
const HOVER_DELAY_MS = 180;

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
  // The session cards' own facts (summary, model, spend, what each is waiting
  // on), for the agent hovercard. Same roster the Observatory draws from —
  // fetched here rather than derived, because none of it is in the terrain
  // payload, and it rides the same live gate so a resting map doesn't poll.
  const roster = useSessionRoster(anyRunning && pageVisible);

  // The heat half-life, in whole days — what the bottom Heat bar sets. A
  // number, not one of three named lenses: the heat math has always taken a
  // raw half-life (HeatSpan), so the chips were only ever presets on this.
  const [heatDays, setHeatDays] = useState(7);
  // Dynamic mode: the half-life stops being a setting and rides the same
  // breath the Observatory backdrop runs on — a day out to a month and back
  // every ten seconds. `breathDays` is the live value while it's on; heatDays
  // keeps whatever she last chose, so leaving the mode lands back there.
  const [breathing, setBreathing] = useState(false);
  const [breathDays, setBreathDays] = useState(7);
  const liveHeatDays = breathing ? breathDays : heatDays;
  const halfLife = liveHeatDays * DAY_SECONDS;
  // Any deliberate touch of the slider or a fixed preset ends the breath —
  // one value, one owner, so the two can never be arguing over it.
  const pickHeatDays = (days: number) => {
    setBreathing(false);
    setHeatDays(days);
  };
  useEffect(() => {
    if (!breathing || !pageVisible) return;
    // Reduced motion pins it at the swell's top rather than dropping the mode:
    // "remember a month back" is still a legible lens standing still.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setBreathDays(breathHalfLife(BREATH_PERIOD_MS * BREATH_INHALE_FRACTION) / DAY_SECONDS);
      return;
    }
    const started = performance.now();
    const tick = () =>
      setBreathDays(breathHalfLife(performance.now() - started, BREATH_PERIOD_MS) / DAY_SECONDS);
    tick();
    const timer = window.setInterval(tick, BREATH_TICK_MS);
    return () => window.clearInterval(timer);
    // Rebuilding the graph ~7x/s is well inside what this page already does —
    // dragging any dial rebuilds it on every input event, i.e. far faster.
    // The node SET is unchanged each tick, so setGraph takes its in-place path
    // and the force layout never re-warms: the map holds still, only the glow
    // moves.
  }, [breathing, pageVisible]);
  const [hiddenRepos, setHiddenRepos] = useState<ReadonlySet<string>>(new Set());
  // The bottom agent control, in two independent parts: the pool button picks
  // WHICH agents are eligible (Active = worked in the last hour / Open = not
  // archived / All) and optionally narrows to one section, while `agentWindow`
  // is a band over that pool ranked most-recent-first — [from, to) by index.
  // Active by default: the map opens on what's happening, not on history.
  const [pool, setPool] = useState<AgentPool>('active');
  const [section, setSection] = useState<AgentSection>('');
  const [agentWindow, setAgentWindow] = useState<{ from: number; to: number }>({ from: 0, to: 8 });
  const [selected, setSelected] = useState<TerrainNode | null>(null);
  const [footprintSession, setFootprintSession] = useState<string | null>(null);
  // The file whose frosted code window is open, if any — the whole node, not
  // just its coordinates, because the window shows what the MAP knows about
  // the file (when it was last touched, which agents touched it) alongside
  // what's in it. Separate from `selected`, which is now only ever an agent
  // orb: a file tap goes straight to its code rather than through a sheet.
  const [codeFile, setCodeFile] = useState<TerrainNode | null>(null);
  // The agent orb under the cursor, once it's rested there long enough to mean
  // it — the anchor for the hovercard. Mouse-only, and the engine drops it the
  // moment the map moves, so this can't be left pointing at nothing.
  const [hover, setHover] = useState<AgentHover | null>(null);

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

  /**
   * Who's eligible at all, straight off the payload's session roster: the
   * chosen pool, then the section filter.
   *
   * "Active" is a real timestamp comparison now (did something within the
   * hour), not the browser-local heartbeat it used to be — so it means the
   * same thing on every device, and an agent working while she isn't watching
   * still counts. `open` and `lane` are server-side too.
   */
  const poolSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of data?.sessions ?? []) {
      if (section && s.lane !== section) continue;
      if (pool === 'all') {
        ids.add(s.id);
        continue;
      }
      if (pool === 'open') {
        if (s.open === true) ids.add(s.id);
        continue;
      }
      // 'active' — a running turn counts even if its last stamp has aged,
      // since a long turn is the most active thing on the map.
      const last = sessionLastSeconds(s.last);
      if (s.running || (last !== null && now - last <= ACTIVE_WINDOW_SECONDS)) ids.add(s.id);
    }
    return ids;
  }, [data?.sessions, pool, section, now]);

  // `alwaysOrbIds` = every agent in the pool. Orbs are otherwise built by
  // inverting files[].sessions, so a pool member that hasn't touched a file
  // yet would have no body on the map at all; this puts it there regardless.
  const graph = useMemo(
    () =>
      filtered
        ? buildTerrainGraph(filtered, halfLife, undefined, { alwaysOrbIds: poolSessionIds })
        : null,
    [filtered, halfLife, poolSessionIds],
  );

  // What's actually drawn — the honest numerator for the Files readout.
  const shownFiles = useMemo(() => (filtered ? terrainFileLoaded(filtered) : 0), [filtered]);

  /** The pool, ranked most-recent-first (running → active → last touched).
   * The agent bar's window slides over THIS list by index. */
  const rankedAgents = useMemo(() => {
    if (!graph) return [];
    return graph.nodes
      .filter((n) => n.kind === 'session' && n.session && poolSessionIds.has(n.session.id))
      .map((n) => ({
        id: n.session!.id,
        title: n.session!.title,
        running: n.session!.running,
        active:
          n.session!.running ||
          (n.session!.last !== null && now - n.session!.last <= ACTIVE_WINDOW_SECONDS),
        open: n.session!.open,
        lane: n.session!.lane,
        files: n.session!.files,
        last: n.session!.last,
      }))
      .sort(
        (a, b) =>
          Number(b.running) - Number(a.running) ||
          Number(b.active) - Number(a.active) ||
          (b.last ?? 0) - (a.last ?? 0),
      );
  }, [graph, poolSessionIds, now]);

  /** The window's slice of the ranked pool — one control, one job. There's no
   * "and also show the active ones" branch any more: the pool button decides
   * membership, this decides how much of it. Clamped to the roster length,
   * which changes whenever the pool does. */
  const shownAgentIds = useMemo(() => {
    const n = rankedAgents.length;
    const to = Math.min(Math.max(agentWindow.to, 1), Math.max(1, n));
    const from = Math.min(Math.max(agentWindow.from, 0), Math.max(0, to - 1));
    return new Set(rankedAgents.slice(from, to).map((a) => a.id));
  }, [agentWindow, rankedAgents]);

  /**
   * Which orbs get their title drawn: the shown agents that did something
   * within the hour. Every orb in the pool is DRAWN — naming them all was
   * right when "active" meant one or two agents, but the Open pool is a dozen
   * and a dozen labels is a wall. So: present but quiet, and named when live.
   * Under the Active pool everything qualifies, so everything is named.
   */
  const labeledAgentIds = useMemo(
    () => new Set(rankedAgents.filter((a) => a.active && shownAgentIds.has(a.id)).map((a) => a.id)),
    [rankedAgents, shownAgentIds],
  );

  const visible = useMemo(() => {
    if (!graph) return null;
    // Orbs carry repoId '' so the repo chips never touch them — they roam
    // across both territories. The agent control governs which orbs are drawn.
    const nodes = graph.nodes.filter(
      (n) =>
        !hiddenRepos.has(n.repoId) &&
        (n.kind !== 'session' || (n.session ? shownAgentIds.has(n.session.id) : false)),
    );
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges };
  }, [graph, hiddenRepos, shownAgentIds]);

  // An orb dropped from view (mode flipped to active, or a session it named
  // aged out of "open") must also drop any state hanging off it, or the sheet
  // and the footprint ring would keep pointing at a body no longer on the map.
  useEffect(() => {
    const shownIds = new Set(
      (visible?.nodes ?? []).filter((n) => n.kind === 'session' && n.session).map((n) => n.session!.id),
    );
    setFootprintSession((cur) => (cur && !shownIds.has(cur) ? null : cur));
    setSelected((cur) =>
      cur?.kind === 'session' && cur.session && !shownIds.has(cur.session.id) ? null : cur,
    );
  }, [visible]);

  /**
   * Agents that have done something since she last opened them — the same
   * comparison behind the session roster's orange "ready" dot, reused verbatim
   * (openedStore.isUnread against each session's last_at) so the map and the
   * list can't drift about who's waiting on her.
   */
  const unreadAgents = useMemo(() => {
    const opened = openedMap();
    const out = new Set<string>();
    for (const s of data?.sessions ?? []) if (isUnread(s.last, opened[s.id])) out.add(s.id);
    return out;
  }, [data?.sessions]);

  /**
   * Who's still pinging: waiting, minus the ones she's tapped on this visit
   * ("until i click it"). Acknowledgement is deliberately LOCAL to the page
   * and not written back to openedStore — tapping an orb to look at it isn't
   * the same as reading the conversation, so the roster keeps its orange dot
   * until she actually opens it. The map just stops waving at her about an
   * agent she's already turned to.
   */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const acknowledge = (id: string) =>
    setAcknowledged((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  const pingingAgents = useMemo(() => {
    const out = new Set<string>();
    for (const id of unreadAgents) if (!acknowledged.has(id)) out.add(id);
    return out;
  }, [unreadAgents, acknowledged]);

  /**
   * Which agents the read/write rings speak for: the ones active within the
   * hour, so their working sets are ringed without her having to tap anything
   * — but the moment one is spotlit, just that one, so the dimmed map answers
   * "what did THIS agent touch" rather than staying a chorus.
   *
   * Deliberately the LABELED set rather than every shown agent: under the Open
   * pool a dozen agents' footprints ringed at once is confetti, and the older
   * ones aren't the question. They stay un-ringed until spotlit.
   */
  const ringSessionIds = useMemo(
    () => (footprintSession ? new Set([footprintSession]) : labeledAgentIds),
    [footprintSession, labeledAgentIds],
  );

  const agentRings = useMemo(
    () => (visible ? agentTouchRings(visible.nodes, ringSessionIds) : new Map<string, FileTouchKind>()),
    [visible, ringSessionIds],
  );

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

  // Tap. A FILE opens straight into its frosted code window over the map —
  // one tap, not a sheet asking whether she'd like to see the code she just
  // pointed at. An agent orb highlights its footprint immediately AND opens
  // its sheet; empty canvas clears everything. (Repo/dir hubs are structure,
  // not destinations — taps pass through.)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.onTap = (node) => {
      if (node?.kind === 'file') {
        if (node.path) setCodeFile(node);
      } else if (node?.kind === 'session' && node.session) {
        setSelected(node);
        setFootprintSession(node.session.id);
        acknowledge(node.session.id); // she turned to it — stop the sonar ping
      } else if (node === null) {
        setSelected(null);
        setFootprintSession(null);
      }
    };
  });

  // Hover → the agent hovercard, with a rest-before-you-show delay so sweeping
  // the cursor across a cluster of orbs doesn't fire a card per orb. Once a
  // card is up the delay is already paid, so moving between orbs swaps
  // instantly; leaving an orb hides it at once. Assigned every render (like
  // onTap above) and closing over refs only, so it never goes stale.
  const hoverTimerRef = useRef<number | null>(null);
  const hoverShownRef = useRef(false);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.onHoverAgent = (next) => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (next === null) {
        hoverShownRef.current = false;
        setHover(null);
        return;
      }
      if (hoverShownRef.current) {
        setHover(next);
        return;
      }
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        hoverShownRef.current = true;
        setHover(next);
      }, HOVER_DELAY_MS);
    };
  });

  // A pending card must not land after the thing it would sit on top of opens.
  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    },
    [],
  );

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
      engine.setFootprintLabels([]);
      return;
    }
    // The session's files plus its own orb — the orb stays lit while its
    // territory is ringed and everything else dims.
    const ids = sessionFootprint(visible.nodes, footprintSession);
    ids.add(`${SESSION_NODE_PREFIX}${footprintSession}`);
    engine.setFootprint(ids);
    // Same files again, ordered newest-touch-first — that order is what lets
    // the canvas thin the captions to the most recent work when she's zoomed
    // too far out to fit them all.
    engine.setFootprintLabels(sessionFootprintByRecency(visible.nodes, footprintSession));
  }, [footprintSession, visible]);

  useEffect(() => {
    engineRef.current?.setAgentRings(agentRings);
  }, [agentRings]);

  useEffect(() => {
    engineRef.current?.setPingingAgents(pingingAgents);
  }, [pingingAgents]);

  useEffect(() => {
    engineRef.current?.setLabeledAgents(labeledAgentIds);
  }, [labeledAgentIds]);

  const toggleRepo = (repoId: string) => {
    setHiddenRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  const openSession = (convId: string) => {
    // On the desktop split the session opens in the LEFT pane's middle tab —
    // the one beside Observatory — so the map stays up in the right half and
    // she can read the conversation next to the footprint it made, instead of
    // the map being replaced by it. Closing the sheet is part of that: the
    // point is seeing the terrain again.
    //
    // Prompt: "i really want for when i click on an agent on the terrain page,
    // that opens that session on the left hand page middle tab next to the
    // observatory rather than the half of the split screen on the right".
    if (openConversationInPane(convId)) {
      setSelected(null);
      return;
    }
    // No left pane (mobile, public) — full navigation, the same destination
    // the atlas's cards use (RosterPage.open). Bot comes from the terrain
    // payload's sessions array when it knows the session, else the atlas
    // conv→bot map, else 'keeper' (v1 single-engine).
    const botId = convToBot.get(convId) ?? 'keeper';
    void navigate({
      to: '/observatory/$botId',
      params: { botId },
      search: { conv: convId },
    });
  };

  // Files are read in the frosted window now, not the sheet, so this is the
  // age line the WINDOW prints under the code.
  const codeFileLast = codeFile?.file ? fileLastTouch(codeFile.file) : null;

  // --- the agent hovercard ------------------------------------------------
  // An overlay is up, so the cursor isn't over the map any more — a card left
  // hanging beside it would be pointing at an orb she can't see.
  const hoverBlocked = codeFile !== null || selected !== null;
  const hoverId = hoverBlocked ? null : (hover?.id ?? null);
  // Fires only while she's actually pointing at one — cached per session, so
  // coming back to the same orb is instant.
  const hoverPreview = useSessionPreview(hoverId);
  const hoverFacts = useMemo(() => {
    if (hoverId === null) return null;
    const agent = rankedAgents.find((a) => a.id === hoverId);
    const meta = roster.data?.sessions.find((s) => s.id === hoverId);
    if (!agent && !meta) return null;
    return {
      title: agent?.title || meta?.title || hoverId,
      // The roster is the authority on running-ness (it's the flag the server
      // staleness-corrects); the map's own copy is the fallback.
      running: meta?.running ?? agent?.running ?? false,
      files: agent?.files ?? 0,
      meta,
      preview: hoverPreview.data,
    };
  }, [hoverId, rankedAgents, roster.data, hoverPreview.data]);

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
      </div>

      <div className={styles.chrome}>
        <div className={styles.topBar}>
          <h1 className={styles.title}>Terrain</h1>
          {/* Which territories are drawn — up here with the other "how much of
              the map to show" controls (Files, Dates). The heat lens moved the
              other way, down to the bottom bar, since it's about how the map
              is coloured rather than what's in it. */}
          <div className={styles.chipRow} role="group" aria-label="Territories">
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
          </div>
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

      {/* How the map is LIT and whose agents are on it, as one full-width row:
          the controls take everything left of the colour key, which holds the
          bottom-right corner and which the Heat bar directly drives. */}
      <div className={styles.chromeBottom}>
        <div className={styles.bottomControls}>
          {/* Heat sits on top of the stack, presets first: how the map is LIT
              is the outer question, and who's on it reads as nested under it.
              The bar paints the ramp along its own track, so this block is
              also the colour key for everything below it. */}
          <TerrainHeatBar
            days={liveHeatDays}
            onDays={pickHeatDays}
            dark={ink?.dark}
            breathing={breathing}
            onBreathe={() => setBreathing((v) => !v)}
          />
          {/* The agent control: Active button, a window that slides past agents
              over the ranked roster, and a popup list to spotlight one. */}
          <TerrainAgentBar
            ranked={rankedAgents}
            shownIds={shownAgentIds}
            pool={pool}
            section={section}
            onPool={setPool}
            onSection={setSection}
            from={agentWindow.from}
            to={agentWindow.to}
            onWindow={(from, to) => setAgentWindow({ from, to })}
            spotlighted={footprintSession}
            onSpotlight={(id) => {
              setFootprintSession(id);
              setSelected(null);
              if (id) acknowledge(id); // tapping its row in the list counts too
            }}
          />
        </div>
        {/* The key holds the bottom-right corner. As a layout sibling it
            reserves its own width, which is what lets the controls beside it
            expand right up to its edge. */}
        {ink && !empty && !isLoading && !isError ? (
          <TerrainKey
            halfLife={halfLife}
            ink={ink}
            hidden={selected !== null || codeFile !== null}
            showAgents={shownAgentIds.size > 0}
          />
        ) : null}
      </div>

      {/* Rest the cursor on an agent orb and its session card floats up beside
          it — what it's working on, what it last said, what it's waiting for —
          without her having to tap in and come back out. Portalled and
          unreachable by the pointer; see AgentHoverCard.tsx. */}
      <AgentHoverCard hover={hoverBlocked ? null : hover} facts={hoverFacts} />

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
      </Sheet>

      {/* Portalled over the canvas — the sim, the zoom transform and the
          layout are all untouched while it's up, so closing it drops you back
          onto exactly the map you left. The window carries what the MAP knows
          about the file under the code: when it was last touched, and which
          agents touched it, each still able to ring its own footprint. That
          was a separate sheet standing between her and the code; it reads
          better as the tail of the file than as a gate in front of it. */}
      <FileCodeWindow
        repo={codeFile?.repoId ?? null}
        path={codeFile?.path ?? null}
        onClose={() => setCodeFile(null)}
      >
        {codeFile?.file ? (
          <div className={styles.sheetBody}>
            <div className={styles.sheetMeta}>
              {codeFileLast !== null ? `last touched ${agoPhrase(codeFileLast)}` : 'no touches in window'}
              {' · '}
              {codeFile.file.touches.length} {codeFile.file.touches.length === 1 ? 'touch' : 'touches'}
            </div>
            {codeFile.file.sessions.length > 0 ? (
              <div className={styles.sessionList}>
                {codeFile.file.sessions.map((s) => (
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
                        // Ringing a footprint is a statement about the MAP, so
                        // the window gets out of the way to show it.
                        setFootprintSession((cur) => (cur === s.id ? null : s.id));
                        setCodeFile(null);
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
      </FileCodeWindow>
    </div>
  );
}
