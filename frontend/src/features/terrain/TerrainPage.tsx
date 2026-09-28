import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { Sheet } from '../../ui';
import { subscribeTheme } from '../../theme';
import { TermNotesPanel } from '../../shell/TermNotesPanel';
import { SchedulePanel } from '../../shell/SchedulePanel';
import { openConversationInPane } from '../../shell/paneConversation';
import { isEmbed } from '../../shell/embed';
import { dispatchIntent } from '../../shell/panels/windowBus';
import { useCreek } from '../creek/api';
import { useFlow } from '../flow/api';
import { useSessionPreview, useSessionRoster } from '../observatory/api';
import { isUnread, openedMap } from '../observatory/readReceipts';
import { cardState, type CardState } from '../observatory/sessionFilters';
import { sessionLocation } from '../observatory/sessionLocation';
import { useTerrain, useTerrainTables, type TerrainData } from './api';
import type { FileTouchKind, TerrainNode } from './terrainGraph';
import { buildThreads, heatThreads } from './terrainThreads';
import {
  agentTouchRings,
  sessionTouchRings,
  alternatingBreath,
  RUN_WINDOW_SECONDS,
  BREATH_INHALE_FRACTION,
  buildTerrainGraph,
  changedFileIds,
  BREATH_PERIOD_MS,
  BREATH_TICK_MS,
  fileLastTouch,
  filterTerrainData,
  filesOutsideRange,
  relativeAge,
  sessionFootprint,
  sessionFootprintByRecency,
  sessionLastSeconds,
  terrainEarliestRun,
  terrainEarliestTouch,
  terrainFileLoaded,
  terrainFileTotal,
  heatKeyTicks,
  HEAT_DAYS_MIN,
  windowToHalfLife,
  SESSION_NODE_PREFIX,
} from './terrainGraph';
import { TerrainDials } from './TerrainDials';
import { ACTIVE_MAX_SECONDS, ACTIVE_MIN_SECONDS } from './activeScale';
import { TerrainSearch } from './TerrainSearch';
import { searchTerrainFiles, SEARCH_LABEL_CAP, type TerrainSearchHit } from './terrainSearch';
import { TerrainHeatBar } from './TerrainHeatBar';
import type { AgentPool, AgentSection } from './TerrainAgentBar';
import { TerrainAgentBar } from './TerrainAgentBar';
import { FileCodeWindow } from './FileCodeWindow';
import { mentionsFromSearch, type CodeMentions } from './codeMentions';
import { codeFileNode, searchWithCodeFile, searchWithoutCodeFile, type CodeFileSearch } from './codeFileSearch';
import { AgentHoverCard } from './AgentHoverCard';
import { CoilHoverCard } from './CoilHoverCard';
import { useCoilCard } from './useCoilCard';
import { TerrainRoomsIndex } from './TerrainRoomsIndex';
import { JourneyPanel, type ReplayRequest } from './JourneyPanel';
import { beatNodeIds, scheduleFrames, type Beat } from './journeyReplay';
import type { TerrainThread } from './terrainThreads';
import { PondLandmark } from './PondLandmark';
import { TerrainGuide } from './TerrainGuide';
import { markGuideDismissed, readGuideDismissed, shouldOpenGuideOnLoad } from './guideOpenPref';
import { collapseToPondTile, localDayISO, parseCardPath, POND_TILE_PATH } from './pondNodes';
import { coilWindowLabel, windowCoils } from './coilFolders';
import { addTableNodes } from './tableNodes';
import { callLinks, tableCodeLinks } from './tableMentions';
import { lineageLinks } from './terrainLineage';
import { swarmGroups } from './terrainSwarms';
import { useSwarms } from '../observatory/swarmApi';
import { tapStage } from './hoverSelection';
import { TerrainTableWindow } from './TerrainTableWindow';
import { fileTypeCounts, OTHER_FILE_TYPE } from './fileTypes';
import { setTypeColorsOn, useTypeColorsOn } from './typeColorPref';
import { setAgentsHiddenOn, useAgentsHiddenOn } from './agentsHiddenPref';
import {
  readThemeInk,
  TerrainCanvas,
  heatRamps,
  typeDotColor,
  type AgentHover,
  type PondAnchor,
  type ThemeInk,
} from './terrainCanvas';
import styles from './TerrainPage.module.css';

/**
 * Journey replay (the ⚡ chip): a captured trace — every file a tap, its
 * requests, the turn and the agent's tool calls crossed — played back on this
 * map. Beats come from journeyReplay.ts; the panel is JourneyPanel.tsx; here
 * it is only timers, `engine.flash` on each beat's dot and a thread from the
 * dot it came from, with the journey's files pinned onto the map for the
 * duration. Arrive with `?journey=<id>` to open on a capture.
 */
/**
 * The color key — a compact panel pinned to the canvas's bottom-right whose
 * whole job is explaining the colors: the ember ramp (just edited #f14c4c at
 * the top, down to ash = old on the dark surface, black on light) with age
 * ticks generated from the heat bar's current half-life, plus one row
 * decoding the session-orb ring. pointer-events: none throughout — pan/zoom
 * passes straight through; it hides while the sheet is up so it never fights
 * the modal.
 *
 * While the "Types" toggle is on the ramp would be explaining colours that
 * aren't on the map, so the key swaps it for the file types that ARE: one
 * swatch and name per type, most common first.
 */
/** How many named types the key lists before the rest are left to "Other" —
 * enough for the types that make up a map, short enough to stay a corner. */
const KEY_TYPE_ROWS = 8;

function TerrainKey({
  windowSeconds,
  ink,
  hidden,
  showAgents,
  typeRows,
  filterNote,
}: {
  /** The heat WINDOW in seconds (what the bar sets) — the ticks are derived
   * from it (heatKeyTicks): now, the midpoint, the edge. */
  windowSeconds: number;
  ink: ThemeInk;
  hidden: boolean;
  /** Drops the orb row from the key when the agents are toggled off — a
   * legend shouldn't decode something that isn't on the map. */
  showAgents: boolean;
  /** The file types on the map right now, most common first — set only while
   * the "Types" toggle is on, and the key lists these instead of the ramp. */
  typeRows: { label: string; color: string }[] | null;
  /** Set only while something is hiding dots — the date range, the heat cut,
   * the active cut, or several at once, named in the order they sit on screen.
   * Heads the key, because it changes what every row under it is describing,
   * and its count is what tells an empty map from a broken one. */
  filterNote: { title: string; count: string } | null;
}) {
  // On the dark surface this is two stops, ash → her red; light keeps the
  // five-step ramp. Same lookup the dots use, so the key can't drift.
  const ramp = heatRamps(ink).ember;
  const gradient = `linear-gradient(to bottom, ${[...ramp].reverse().join(', ')})`;
  const orb = ink.accent; // agents (and their tethers) wear the app --accent — matches the engine
  return (
    <div
      className={[styles.key, hidden ? styles.keyHidden : ''].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      {filterNote ? (
        <div className={styles.keyNote}>
          <span className={styles.keyNoteTitle}>{filterNote.title}</span>
          <span className={styles.keyTick}>{filterNote.count}</span>
        </div>
      ) : null}
      {typeRows ? (
        <div className={styles.keyTypes}>
          {typeRows.map((row) => (
            <div key={row.label} className={styles.keySessionRow}>
              <span className={styles.keySwatch} style={{ background: row.color }} />
              <span className={styles.keyTick}>{row.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.keyScale}>
          <div className={styles.keyBar} style={{ background: gradient }} />
          <div className={styles.keyTicks}>
            {heatKeyTicks(windowSeconds).map((tick) => (
              <span key={tick} className={styles.keyTick}>
                {tick}
              </span>
            ))}
          </div>
        </div>
      )}
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
 * /terrain/map — "where is being worked on": every file the observatory's
 * sessions touched in the window, as a force-directed tree per repo (App
 * code / Vault), files glowing ember by recency. This is where /terrain
 * lands, and the terrain's other rooms (/terrain/usage, /terrain/sql) are
 * reached from here through the Rooms door in the top bar: the map blurs and
 * an index of opaque cards rises, each one a whole page you go to
 * (TerrainRoomsIndex). The rule the whole surface follows now: a LENS floats
 * over the map (the file code window, the agent hovercard — re-readings of
 * what's on it), a PAGE is somewhere you leave it for.
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
 * Tap a file → its code in a pane over the whole terrain panel — this
 * panel only, never a neighbour in a split — × to come back (FileCodeWindow), with
 * what the map knows about the file printed under it:
 * when it was last touched, and every agent that touched it — each row opens
 * that conversation in the Observatory, or rings its whole footprint on the
 * map.
 *
 * AGENTS AND TABLES TAKE TWO CLICKS, files one. Clicking an agent orb rings
 * its whole footprint and nothing else; clicking the ringed one again opens
 * its sheet. Clicking a table pins lit everything it's joined to — its
 * foreign keys, and the ropes out to the code files that touch it — and
 * clicking the pinned one again opens its card. A double-click is two clicks
 * on the same body, so it does both at once; the empty canvas clears both.
 * The rule itself is hoverSelection.ts. This is why: looking at what an agent
 * has hold of, or at what a table is wired to, is the commonest thing to want
 * from those bodies, and it used to cost a card thrown over the map and a
 * dismissal every single time.
 *
 * THE POND floats over the map's own journal country. The card pool and the
 * diary are real vault files — the largest single cluster on the terrain — so
 * a small, deliberately crude pond sits over that cluster; reaching for it
 * grows it, resolves its silhouette, lights the water under the real dots, and
 * shows which filters the pond is currently set to; clicking enters
 * /terrain/pond. Coming back out lands on the map with those filters still on
 * the landmark. See PondLandmark.tsx.
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

/** How long a card survives the cursor leaving. This is what makes the card
 * REACHABLE: there are 16px of bare canvas between an orb and its card
 * (ORB_GAP), and crossing them reads to the map as "she left" — without a
 * grace period the card would dismiss itself every single time she set off
 * towards it. Long enough to cross a gap and a wobble, short enough that a card
 * she's genuinely walked away from is gone before she notices it lingering.
 * A pan or zoom skips it entirely (the `hard` flag). */
const HOVER_LEAVE_MS = 240;

/**
 * How many files per repo to ask the server for, escalating as the Files
 * dial climbs. Tiers rather than the exact count so a drag doesn't fire a
 * request per pixel: within a tier the dial slices locally (instant), and
 * only crossing one costs a fetch — which react-query then caches, so
 * sliding back down is instant too. `null` = every file there is.
 *
 * The map OPENS on `null` — every file, both repos, ~4,000 drawn nodes once
 * the pond has collapsed the card pool into its tile. The tiers below it are
 * what the Files dial slides back down to, not a ladder it has to climb: a
 * map that shows most of the corpus and calls it the terrain is telling her
 * something false about her own codebase. The cost is honest and it's
 * front-loaded — a bigger first payload, a heavier first settle — and the
 * layout memory (layoutMemory.ts) means that settle happens once, not on
 * every visit.
 *
 * Prompt that produced it: "i also want ALL my files to show by default
 * rather than only a subset of them."
 */
const FETCH_TIERS: readonly (number | null)[] = [350, 1000, 2500, null];

/**
 * One view's Active setting (notes 6 and 9 in TerrainHeatBar.tsx): GOLD'S
 * WINDOW — in SECONDS, on an axis that runs from five minutes to a week
 * (activeScale.ts) — and whether it's on "All time" instead. The heat map and
 * the Types view each carry their own.
 *
 * The window is one number doing one job: how recently a file must have RUN to
 * still be lit gold on the map. It used to be only a ring's cutoff, with the
 * fire itself pinned at a fixed day somewhere else — two owners of one
 * question, one of them invisible.
 *
 * There used to be a `heatCut` here too, turning the colour edge into a filter
 * ("only what's still lit"). It's gone — heat colours the map and doesn't
 * decide what's on it. Owner: "the heat map one should be the heat map alone
 * and not the activity toggle."
 */
interface ViewCuts {
  activeSeconds: number;
  activeAllTime: boolean;
}

/** Gold's window on the last day — so the map opens lit exactly as it always
 * has been ("did this code run today",
 * terrainGraph.ts RUN_WINDOW_SECONDS). The slider starts on that number rather
 * than under it because gold's window used to BE that constant, fixed; making
 * it hers to move shouldn't change what she sees on open. */
const NO_CUTS: ViewCuts = { activeSeconds: RUN_WINDOW_SECONDS, activeAllTime: false };

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
  const router = useRouter();
  const pageVisible = usePageVisible();
  // A logged-out visitor — on the private site's public view or the
  // public-only mirror. The MAP is public (public_config.PUBLIC_PATHS), and
  // so is everything on it that is shape rather than speech: the dots, the
  // tables, the threads (creek), the pond's silhouette, and any file that is
  // tracked app code (the server refuses the rest with 403 — the window
  // shows "private"). What a visitor still doesn't get is what would quote
  // her or write for her: the session roster and hovercard, flow (it carries
  // the text being written), the notes and schedule panels, the rooms, and
  // the journey recorder. Owner's calls: 2026-09-17, "i am ok with personal
  // stuff showing on the map, just make all personal files unreadable to
  // visitors, but the code can be interactive"; 2026-09-22, "make it such
  // that mudscryer.org shows exactly the UI that i see on my personal".
  const visitor = typeof window !== 'undefined' && window.VIEW_MODE === 'public';
  // The EMBED view (?embed=1, shell/embed.ts): the map as a card inside an
  // <iframe> on the owner's portfolio page. Its one job there is "it's alive"
  // — so no chrome at all, the breathing (Dynamic) heat preset from the first
  // frame, the Open agent pool so the card isn't empty on a quiet day, and a
  // single "Open Terrain ↗" door to the full map. Everything else — pan, zoom,
  // tapping a dot — is the map as it is. Read once: an embed never navigates.
  // Prompt: "the card's one job is it's alive … breathing glow always on,
  // plus open agents as orbs. That's all that moves."
  const embed = isEmbed();
  // Live mode: while any payload session is running AND the page is visible,
  // poll ~5s so a working session's touches light up as they happen. The
  // flag comes from the last payload, so the first fetch always runs cold
  // and the poll turns itself off when the last session goes quiet.
  const [anyRunning, setAnyRunning] = useState(false);
  // Everything, from the first frame — except in the embed, where the map is a
  // decorative card on a public page and the hottest few hundred is plenty for
  // "it's alive" at a fraction of the payload.
  const [tier, setTier] = useState<number | null>(embed ? FETCH_TIERS[0] : null);
  const { data, isLoading, isError, isFetching, dataUpdatedAt, refetch } = useTerrain(
    anyRunning && pageVisible,
    tier,
  );
  // The database's tables, for the map's table layer (tableNodes.ts). Open to
  // visitors too since the values were frosted: a stranger gets the tables,
  // their columns and their shapes, and every cell comes back as blocks
  // (routes/terrain_tables.py). Her ask: "i want it published but the actual
  // values inside of the tables will be blurred."
  const { data: tables, refetch: refetchTables } = useTerrainTables(true);
  useEffect(() => {
    if (data) setAnyRunning((data.sessions ?? []).some((s) => s.running));
  }, [data]);
  // The session cards' own facts (summary, model, spend, what each is waiting
  // on), for the agent hovercard. Same roster the Observatory draws from —
  // fetched here rather than derived, because none of it is in the terrain
  // payload, and it rides the same live gate so a resting map doesn't poll.
  const roster = useSessionRoster(anyRunning && pageVisible, !visitor);

  // Which view is lit: heat colours, or file-type colours (note 7 in
  // TerrainHeatBar.tsx). A shared preference (typeColorPref.ts), so a terrain
  // in another panel flips with this one. Read up here because the Active
  // setting below is kept PER VIEW, and gold's window comes out of it.
  const typeColors = useTypeColorsOn();

  // The Active bar's window, per view (notes 6 and 9 in TerrainHeatBar.tsx).
  // Each view keeps its own, so a window set up under Types doesn't follow her
  // back to the heat map. Page state, not a stored preference — it's a
  // question she's asking right now.
  const [cutsByView, setCutsByView] = useState<Record<'heat' | 'types', ViewCuts>>({
    heat: { ...NO_CUTS },
    types: { ...NO_CUTS },
  });
  const view: 'heat' | 'types' = typeColors ? 'types' : 'heat';
  const cuts = cutsByView[view];
  const setCuts = (patch: Partial<ViewCuts>) =>
    setCutsByView((prev) => ({ ...prev, [view]: { ...prev[view], ...patch } }));

  // "Now" comes off the payload, not the wall clock, so it only advances when
  // fresh data arrives — a live-polling map doesn't jitter its own date range
  // between renders.
  const now = useMemo(() => {
    const stamped = data ? Date.parse(data.generated_at) : NaN;
    return Number.isFinite(stamped) ? stamped / 1000 : Date.now() / 1000;
  }, [data]);

  // The oldest touch in the payload: the date range's left edge, and how far
  // back Heat's "All time" reaches.
  const earliest = useMemo(
    () => (data ? terrainEarliestTouch(data, now) : now - 90 * DAY_SECONDS),
    [data, now],
  );

  // The heat WINDOW, in whole days — what the bottom Heat bar sets: how far
  // back a file stays lit, with the thumb as the edge of the colour. A number,
  // not one of three named lenses; the presets are only shortcuts on it.
  const [heatDays, setHeatDays] = useState(7);
  // Whether each fire paints at all — the Heat and Active names on the bar are
  // these switches (note 8 in TerrainHeatBar.tsx). Off means that fire adds
  // nothing to the map: no colour, no folder growth, and for gold no threads
  // either. File dots are sized by bytes, so they keep their size.
  // Shared by both views and not remembered across reloads.
  const [heatOn, setHeatOn] = useState(true);
  const [goldOn, setGoldOn] = useState(true);
  // Heat's "All time" (note 9 in TerrainHeatBar.tsx). While on, the window is
  // worked out from the payload below; heatDays keeps what she last chose, so
  // switching it off lands back there — the same arrangement as Dynamic.
  const [heatAllTime, setHeatAllTime] = useState(false);
  // Dynamic mode: the window stops being a setting and rides the same breath
  // the Observatory backdrop runs on — a day out to a month and back every
  // ten seconds. `breathDays` is the live value while it's on; heatDays keeps
  // whatever she last chose, so leaving the mode lands back there.
  const [breathing, setBreathing] = useState(embed);
  const [breathDays, setBreathDays] = useState(7);
  // Gold's live window under the breath. The two fires take turns
  // (terrainGraph.ts alternatingBreath): one cycle ember reaches back to a
  // month and returns while gold rests at five minutes; the next, gold
  // swells out to a day and returns while ember rests at a day. Each rests
  // at its smallest, so yellow is fullest exactly when red is quietest. On
  // any fixed preset gold is the fixed one-day question.
  const [goldBreathSeconds, setGoldBreathSeconds] = useState<number>(RUN_WINDOW_SECONDS);
  // "All time" for each fire: back to the oldest thing it has on record. Heat
  // reaches to the oldest edit in the payload (the date range's own left
  // edge); gold to the oldest run, falling back to the bar's week when nothing
  // has run. Both are floored at their bar's minimum so a brand-new install
  // can't produce a zero-length window.
  const allTimeHeatDays = Math.max(HEAT_DAYS_MIN, (now - earliest) / DAY_SECONDS);
  const allTimeActiveSeconds = useMemo(() => {
    const oldestRun = data ? terrainEarliestRun(data) : null;
    return oldestRun === null
      ? ACTIVE_MAX_SECONDS
      : Math.max(ACTIVE_MIN_SECONDS, now - oldestRun);
  }, [data, now]);
  // Heat's live window: the breath under Dynamic, the all-time reach under
  // All time, otherwise the slider.
  const liveHeatDays = breathing ? breathDays : heatAllTime ? allTimeHeatDays : heatDays;
  const windowSeconds = liveHeatDays * DAY_SECONDS;
  // Gold's live window, the mirror of liveHeatDays: the gold breath under
  // Dynamic, the oldest run under All time, otherwise the Active slider. It
  // drives the map's gold fire — the Active bar is gold's bar, not a second
  // opinion about a window fixed somewhere else.
  const liveActiveSeconds = breathing
    ? goldBreathSeconds
    : cuts.activeAllTime
      ? allTimeActiveSeconds
      : cuts.activeSeconds;
  // The decay runs on a half-life a third of the window (terrainGraph.ts,
  // windowToHalfLife) so the glow has run out by the window's edge.
  const halfLife = windowToHalfLife(windowSeconds);
  const goldHalfLife = windowToHalfLife(liveActiveSeconds);
  // Any deliberate touch of either slider, or of a fixed preset, ends the
  // breath — one value, one owner, so the two can never be arguing over it.
  // All time is one more owner of the same value, so it follows the same
  // rule: any other touch takes the window back from it, and pressing it
  // takes the window back from Dynamic. Turning it on also lights that fire,
  // since all of a colour's history is nothing to look at with the colour off.
  // Turning it off leaves the switch alone.
  const pickHeatDays = (days: number) => {
    setBreathing(false);
    setHeatAllTime(false);
    setHeatDays(days);
  };
  const pickActiveSeconds = (seconds: number) => {
    setBreathing(false);
    setCuts({ activeSeconds: seconds, activeAllTime: false });
  };
  const pickHeatAllTime = (on: boolean) => {
    setBreathing(false);
    setHeatAllTime(on);
    if (on) setHeatOn(true);
  };
  const pickActiveAllTime = (on: boolean) => {
    setBreathing(false);
    setCuts({ activeAllTime: on });
    if (on) setGoldOn(true);
  };
  const toggleBreathing = () => {
    if (!breathing) {
      setHeatAllTime(false);
      setCuts({ activeAllTime: false });
    }
    setBreathing(!breathing);
  };
  useEffect(() => {
    if (!breathing || !pageVisible) return;
    // Reduced motion pins it at the swell's top rather than dropping the mode:
    // "remember a month back" is still a legible lens standing still. Gold is
    // pinned at its day (the fixed question) rather than the five minutes it
    // rests at during ember's turn — a still map should still show what ran.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const b = alternatingBreath(BREATH_PERIOD_MS * BREATH_INHALE_FRACTION, BREATH_PERIOD_MS);
      setBreathDays(b.ember / DAY_SECONDS);
      setGoldBreathSeconds(RUN_WINDOW_SECONDS);
      return;
    }
    const started = performance.now();
    // One clock, two windows, one of them moving at a time.
    const tick = () => {
      const b = alternatingBreath(performance.now() - started, BREATH_PERIOD_MS);
      setBreathDays(b.ember / DAY_SECONDS);
      setGoldBreathSeconds(b.gold);
    };
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
  // The terminal's floating sidekicks, ported the same way the Observatory
  // ported them: 📝 dev notes and the ⏰ prompt timer, the same shared panels
  // off the same stores. The map is where she notices what needs doing, so it
  // wants the same two doors every other working surface has.
  // Whether the rooms index — the blurred-map hallway of cards — is up. Local
  // state, not a route: it's a moment of choosing, not a place, so the back
  // button never has to step through it. The rooms themselves are full pages
  // (/terrain/usage, /terrain/sql) that unmount this map entirely.
  const [roomsOpen, setRoomsOpen] = useState(false);
  // The Guide: what the shapes and colours mean and what a tap does, docked
  // down the right side with the map still working beside it. Opens by itself
  // for a first-time visitor and stays closed for the owner (guideOpenPref.ts);
  // closing it once is remembered, so it never nags.
  const [guideOpen, setGuideOpen] = useState(() =>
    shouldOpenGuideOnLoad({ visitor, embed, dismissed: readGuideDismissed() }),
  );
  const closeGuide = () => {
    setGuideOpen(false);
    markGuideDismissed();
  };

  // --- journey replay ---------------------------------------------------------
  // A captured journey (Wiring room / runtime_trace.py) played back on the
  // map: each beat flashes the dot it reached and lights a thread from the
  // dot it came from, on the trace's own clock stretched by `slow`. The beats
  // are pure data (journeyReplay.ts); this is only the timers and the two
  // engine calls. Arriving with `?journey=<id>` (the Wiring room's "replay on
  // the terrain" link) opens the panel on that capture.
  const search = useSearch({ strict: false }) as { journey?: string } & CodeFileSearch;
  const [journeyOpen, setJourneyOpen] = useState(Boolean(search.journey));
  const [replay, setReplay] = useState<ReplayRequest | null>(null);
  const [replayThreads, setReplayThreads] = useState<TerrainThread[] | null>(null);
  const [replayPins, setReplayPins] = useState<ReadonlySet<string> | undefined>(undefined);
  const [replayProgress, setReplayProgress] = useState<{ done: number; total: number; label: string } | null>(null);

  const [panel, setPanel] = useState<'notes' | 'schedule' | null>(null);
  const [schedSessions, setSchedSessions] = useState<string[]>([]);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const schedBtnRef = useRef<HTMLButtonElement>(null);
  const togglePanel = (name: 'notes' | 'schedule') => {
    // The timer schedules prompts into tmux sessions (the dispatcher's
    // delivery lane) — fetch their names once, on first open.
    if (name === 'schedule' && schedSessions.length === 0) {
      fetch('/api/sessions')
        .then((r) => r.json())
        .then((d) => setSchedSessions(Array.isArray(d.sessions) ? d.sessions : []))
        .catch(() => {});
    }
    setPanel((p) => (p === name ? null : name));
  };

  const [pool, setPool] = useState<AgentPool>(embed ? 'open' : 'active');
  const [section, setSection] = useState<AgentSection>('');
  const [agentWindow, setAgentWindow] = useState<{ from: number; to: number }>({ from: 0, to: 8 });
  const [selected, setSelected] = useState<TerrainNode | null>(null);
  const [footprintSession, setFootprintSession] = useState<string | null>(null);
  // The table she has CLICKED, by node id — picked out but not opened. One
  // click picks a table out and lights everything it's joined to (its foreign
  // keys, and the code files that touch it); clicking the picked-out one again
  // opens its card. Agents work the same way one state along —
  // `footprintSession` is their version of this.
  //
  // Prompt that produced it: "clicking an agent highlights that agent and the
  // files it's touching rather than making a popup … a double click on the
  // agents to make a popup. same for the sql".
  const [heldTable, setHeldTable] = useState<string | null>(null);
  // The file search (top bar). Non-empty → the map dims to the matching
  // files, the same spotlight an agent tap uses; the two are exclusive
  // (typing clears the agent, tapping an agent clears the query), so they
  // can never argue over the same pixels.
  const [query, setQuery] = useState('');
  // The agent orb under the cursor, once it's rested there long enough to mean
  // it — the anchor for the hovercard. Mouse-only, and the engine drops it the
  // moment the map moves, so this can't be left pointing at nothing.
  const [hover, setHover] = useState<AgentHover | null>(null);
  // The cursor has travelled off the map and INTO that card — she's reading it,
  // not passing it. Holds it open against the leave timer and lets it show its
  // buttons and scroll its text.
  const [hoverEngaged, setHoverEngaged] = useState(false);

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
  // The map no longer re-fetches itself every time she opens the page (see
  // useTerrain's staleTime), so the refresh chip has to say how old what she's
  // looking at is. A bump every 30s keeps that label honest; nothing else in
  // the page depends on it, and it stops while the tab is in the background.
  const [, bumpAge] = useState(0);
  useEffect(() => {
    if (!pageVisible) return;
    const t = window.setInterval(() => bumpAge((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [pageVisible]);
  // On a PUBLIC MIRROR the age that matters is when the private box built this
  // map, not when the browser fetched it: the mirror serves a stored artifact,
  // so a visitor re-fetching a frozen map every five seconds would read "now"
  // forever. Any locally-built map has no published_ts and keeps the fetch age.
  const publishedSeconds = data?.mirror ? (data.published_ts ?? null) : null;
  const dataAge = publishedSeconds
    ? relativeAge(publishedSeconds)
    : dataUpdatedAt
      ? relativeAge(dataUpdatedAt / 1000)
      : null;
  // Live mode already polls every ~5s; spinning the chip on each of those would
  // be a flicker that means nothing. The spin is for a fetch SHE asked for.
  const refreshing = isFetching && !(anyRunning && pageVisible);
  const refreshMap = () => {
    void refetch();
    void refetchTables();
  };

  // How many nodes she's dragged into place — reported by the engine, and the
  // only reason the "release" chip exists. It appears when there's something to
  // release and is gone the rest of the time.
  const [pinnedCount, setPinnedCount] = useState(0);

  // Live theme tokens for the HTML color key (the engine keeps its own copy)
  // — set on mount and kept fresh by the same subscription below.
  const [ink, setInk] = useState<ThemeInk | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TerrainCanvas | null>(null);
  const fittedRef = useRef(false);

  /**
   * How far back each coil is open, in days, keyed by its folder — its first
   * step to begin with (a month, by default), one step wider each time she
   * pulls on the curve at its tip, and back to the first when she taps its
   * centre (coilFolders.ts). Per coil,
   * because a chat log and a photo archive don't fill at the same rate and
   * shouldn't be opened together.
   *
   * Deliberately NOT persisted, unlike the sticky toggles next door: every
   * coil opening at its first step on load is what makes "it stays about the
   * same size unless you interact with it" true across visits and not just
   * within one. A six-month coil is something she asked for in a moment, not
   * a setting.
   */
  const [coilWindows, setCoilWindows] = useState<Record<string, number | null>>({});
  /** The coil card: what a coil is showing and the sizes it opens to — up on
   * a mouse's rest over a coil's centre, or a finger's tap (CoilHoverCard.tsx). */
  const coilCard = useCoilCard();

  /**
   * Her coil folders cut to their windows, and re-timed, before anything else
   * looks at the payload — same slot in the pipeline as the pond's collapse
   * below, and for the same reason: what reaches the graph should already be
   * the thing the map means to draw.
   *
   * Two jobs, both in coilFolders.ts: only each window's files get through
   * (these are the biggest folders in the vault and most of what's in them is
   * old), and on a 'stamp' coil every one that does has its git history
   * swapped for the moment in its filename — because for a folder git only
   * bulk-moves, the commits record vault maintenance rather than anything she
   * did, and the coil is lit by those times.
   */
  const coiled = useMemo(
    () => (data ? windowCoils(data, { windows: coilWindows }) : null),
    [data, coilWindows],
  );

  /**
   * The journal collapsed BEFORE anything else looks at the payload: every
   * card file (~1,700 anonymous dots, the biggest and least readable
   * structure on the map) is swapped for ONE synthetic node — the pond tile,
   * a month of journal bucketed per day that the canvas draws as a small
   * square of water with a real collision body. See pondNodes.ts.
   *
   * Collapse first, then the dials: the tile is one whole thing, so the
   * Files dial's hottest-N cut can't land in the middle of the journal and
   * quietly under-count it — and the date dial still reaches inside
   * (filterTerrainData filters the tile's day buckets too).
   */
  const collapsed = useMemo(
    () => (coiled ? collapseToPondTile(coiled.data, localDayISO()) : null),
    [coiled],
  );

  // Search runs over the whole payload (not the drawn nodes) so the Files
  // dial can't hide a hit; every hit is then PINNED past the dial's cut
  // below, the same way the journey replay pins its files. Repos toggled
  // off stay off — the chips say what's on the map, search only lights it.
  const searchHits = useMemo(
    () => searchTerrainFiles(collapsed?.data, query, { hiddenRepos }),
    [collapsed, query, hiddenRepos],
  );
  const searchIds = useMemo(
    () => (searchHits.length ? new Set(searchHits.map((h) => h.id)) : null),
    [searchHits],
  );
  const pins = useMemo(() => {
    // The coil is pinned past the dials whole. It's an arrangement, not a
    // ranking: the Files dial cutting the cold half of it would leave a
    // spiral with a bite out of the outer arm, which reads as a bug rather
    // than as a filter. The window she set on the coil is the only thing that
    // decides how much of it is drawn.
    const coilIds = (coiled?.coils ?? []).flatMap((coil) => coil.spiralIds);
    if (!searchIds && coilIds.length === 0) return replayPins;
    const all = new Set<string>(replayPins ?? []);
    for (const id of searchIds ?? []) all.add(id);
    for (const id of coilIds) all.add(id);
    return all;
  }, [replayPins, searchIds, coiled]);

  // The dials narrow the payload (time, then count), and the graph is built
  // from what survives — so heat, ages and session lists all describe the
  // chosen span rather than all time.
  const filtered = useMemo(
    () =>
      collapsed
        ? filterTerrainData(
            collapsed.data,
            { from: range.from, to: range.to, count: effectiveCount, pinned: pins },
            now,
          )
        : null,
    [collapsed, range.from, range.to, effectiveCount, now, pins],
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

  // Put the database's tables on the map: one body per table, added AFTER the
  // dials so neither the Files cut nor the date range can remove them — both
  // rank by edit history, and a table has none. See tableNodes.ts.
  const withTables = useMemo(
    () => (filtered ? addTableNodes(filtered, tables) : null),
    [filtered, tables],
  );

  // `alwaysOrbIds` = every agent in the pool. Orbs are otherwise built by
  // inverting files[].sessions, so a pool member that hasn't touched a file
  // yet would have no body on the map at all; this puts it there regardless.
  const graph = useMemo(
    () =>
      withTables
        ? // A fire switched off on the bar builds with a zero half-life, which
          // scores every file at zero for that fire (computeFileHeat,
          // computeRunHeat) — so it adds no colour anywhere.
          buildTerrainGraph(withTables, heatOn ? halfLife : 0, undefined, {
            alwaysOrbIds: poolSessionIds,
            runHalfLife: goldOn ? goldHalfLife : 0,
          })
        : null,
    [withTables, heatOn, halfLife, goldOn, goldHalfLife, poolSessionIds],
  );

  // The file whose code page is open, if any — read off the ADDRESS, not held
  // in memory (codeFileSearch.ts). That is what makes a refresh reopen the
  // same file, and what makes closing it a real "back". It is the whole node,
  // not just its coordinates, because the window shows what the MAP knows
  // about the file (when it was last touched, which agents touched it)
  // alongside what's in it. Separate from `selected`: a file tap goes
  // straight to its code rather than through a sheet.
  const codeFile = useMemo(
    () => codeFileNode(search.repo, search.file, graph?.nodes),
    [search.repo, search.file, graph],
  );
  // Set only when the file was opened FROM a table's card: which table she
  // came in asking about, and every line this file names it on. The open file
  // lands on the first and steps between the rest (FileCodeBody's mention
  // strip). Null for a file opened any other way — a tapped dot is not a
  // question about a table, and a strip saying so would be noise.
  const codeMentions = useMemo(
    () => mentionsFromSearch(search.mentions, search.of) ?? null,
    [search.mentions, search.of],
  );

  // Open a file over the map by stepping the address forward. A push, not a
  // replace, so the browser's history gains one entry and "back" means
  // "close the file".
  const openCodeFile = useCallback(
    (repo: string, path: string, mentions?: CodeMentions) => {
      void navigate({
        to: '/terrain/map',
        search: (previous) => searchWithCodeFile(previous as CodeFileSearch, repo, path, mentions),
      });
    },
    [navigate],
  );
  // Close the open file by going BACK — the ×, Esc, the browser's back
  // button and a swipe-back are one and the same move, and land wherever she
  // opened the file from. When there is no "back" to go to (a pasted link, a
  // fresh tab, a tile reopened after a refresh — its private history doesn't
  // survive one), take the file out of the address instead, which shows the
  // map. That is a replace, so the dead-end entry doesn't linger in history.
  // Her ask: "the x is fine if it's functionally the same as a back button."
  const closeCodeFile = useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back();
      return;
    }
    void navigate({
      to: '/terrain/map',
      search: (previous) => searchWithoutCodeFile(previous as CodeFileSearch),
      replace: true,
    });
  }, [router, navigate]);

  // The threads: what one file makes, another one eats. The creek payload is
  // static wiring plus per-collection write freshness, so it changes on the
  // order of minutes, not frames — built once per payload and only re-lit on
  // the breath below.
  const { data: creek } = useCreek(14);
  const threads = useMemo(() => buildThreads(creek), [creek]);

  // Lit on the SAME window the gold dots ride, gold breath included, so a
  // thread and a dot of equal age are equally bright and the two read as one
  // system rather than two overlays that happen to share a canvas. With gold
  // switched off they go dark with it — they're gold's ink.
  const litThreads = useMemo(
    () => heatThreads(threads, goldOn ? goldHalfLife : 0),
    [threads, goldOn, goldHalfLife],
  );

  useEffect(() => {
    // While a replay runs, its threads own the canvas: they're the answer to
    // a question she just asked, and the ambient ones would read as noise
    // beneath them. Restored the moment the replay clears.
    engineRef.current?.setThreads(replayThreads ?? litThreads);
  }, [litThreads, replayThreads]);

  // The table-to-code ropes: which files touch which table, as pairs of node
  // ids. Built against the graph the map actually drew, so a file the Files
  // dial cut gets no rope to nowhere; the canvas draws them only under a
  // hover (terrainCanvas.ts setTableCodeLinks).
  const codeLinks = useMemo(
    () => tableCodeLinks(tables, new Set((graph?.nodes ?? []).map((n) => n.id))),
    [tables, graph],
  );
  useEffect(() => {
    engineRef.current?.setTableCodeLinks(codeLinks);
  }, [codeLinks]);

  // The page-to-route ropes: which frontend files call which route modules —
  // the leg before the table ropes, so a hover follows page -> route -> table
  // (terrainCanvas.ts setCallLinks). Built against the drawn graph, the same way.
  const pageLinks = useMemo(
    () => callLinks(tables, new Set((graph?.nodes ?? []).map((n) => n.id))),
    [tables, graph],
  );
  useEffect(() => {
    engineRef.current?.setCallLinks(pageLinks);
  }, [pageLinks]);

  // The spinoff arrows: which agent was spun off from which. Every pair goes
  // over; the canvas draws only those with both orbs on the map
  // (terrainCanvas.ts setLineage).
  // Kept in a ref too: the canvas is built by a later effect, and with the map
  // already cached the first hand-over would find no canvas — so the build
  // hands the latest pairs over itself.
  const spinoffLinks = useMemo(() => lineageLinks(data?.sessions ?? []), [data?.sessions]);
  const spinoffLinksRef = useRef(spinoffLinks);
  spinoffLinksRef.current = spinoffLinks;
  useEffect(() => {
    engineRef.current?.setLineage(spinoffLinks);
  }, [spinoffLinks]);

  // The swarm outlines: which agents have been messaging each other. Same
  // hand-over as the spinoff arrows, ref included (terrainCanvas.ts setSwarms).
  // The owner's only — a visitor never asks.
  const swarmsQuery = useSwarms(!visitor);
  const swarmList = useMemo(() => swarmGroups(swarmsQuery.data ?? []), [swarmsQuery.data]);
  const swarmListRef = useRef(swarmList);
  swarmListRef.current = swarmList;
  useEffect(() => {
    engineRef.current?.setSwarms(swarmList);
  }, [swarmList]);

  // The replay runner. Frames are pre-batched (beats within 40ms share one
  // flash); each frame flashes its dots and appends its threads to the lit
  // set, which stays up for a few seconds after the last beat so the whole
  // path can be read at once before it fades back to the ambient map.
  useEffect(() => {
    if (!replay) return;
    const engine = engineRef.current;
    if (!engine) return;
    const frames = scheduleFrames(replay.beats, replay.slow);
    const total = replay.beats.length;
    let done = 0;
    const threads: TerrainThread[] = [];
    const seen = new Set<string>();
    const timers: number[] = [];
    setReplayThreads([]);
    setReplayProgress({ done: 0, total, label: 'starting…' });
    const t0 = performance.now();
    for (const frame of frames) {
      timers.push(
        window.setTimeout(() => {
          const ids = new Set<string>();
          let last: Beat | null = null;
          for (const b of frame.beats) {
            if (b.nodeId) ids.add(b.nodeId);
            if (b.nodeId && b.fromId && b.fromId !== b.nodeId) {
              const key = `${b.fromId}>${b.nodeId}`;
              if (!seen.has(key)) {
                seen.add(key);
                threads.push({ sourceId: b.fromId, targetId: b.nodeId, collection: `journey:${b.kind}`, lastWrite: null, t: 1, always: true });
              }
            }
            last = b;
          }
          done += frame.beats.length;
          if (ids.size) engine.flash(ids);
          setReplayThreads([...threads]);
          setReplayProgress({ done, total, label: last ? `${last.kind} · ${last.label}` : '' });
        }, Math.max(0, frame.atMs - (performance.now() - t0))),
      );
    }
    const end = (frames[frames.length - 1]?.atMs ?? 0) + 4000;
    timers.push(
      window.setTimeout(() => {
        setReplay(null);
        setReplayThreads(null);
        setReplayProgress(null);
      }, end),
    );
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [replay]);

  // What's actually drawn — the honest numerator for the Files readout.

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

  // Read the "hide agents" switch (agentsHiddenPref.ts). The embed card never
  // honours it: it has no controls, so a map hidden there could never be
  // un-hidden from there.
  const agentsHidden = useAgentsHiddenOn() && !embed;

  /** The window's slice of the ranked pool — one control, one job. There's no
   * "and also show the active ones" branch any more: the pool button decides
   * membership, this decides how much of it. Clamped to the roster length,
   * which changes whenever the pool does.
   *
   * Hiding agents empties this list, and that is the whole mechanism: orbs,
   * tethers, name labels, read/write rings, the spotlight and the key's agent
   * row all follow it, so none of them needs its own "hidden" check. The pool
   * and window choices are left as they were, ready for when she shows them
   * again. */
  const shownAgentIds = useMemo(() => {
    if (agentsHidden) return new Set<string>();
    const n = rankedAgents.length;
    const to = Math.min(Math.max(agentWindow.to, 1), Math.max(1, n));
    const from = Math.min(Math.max(agentWindow.from, 0), Math.max(0, to - 1));
    return new Set(rankedAgents.slice(from, to).map((a) => a.id));
  }, [agentWindow, rankedAgents, agentsHidden]);

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
   * (readReceipts.isUnread against each session's last_at) so the map and the
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
   * and not written back to readReceipts — tapping an orb to look at it isn't
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
   * Which agents the read/write rings speak for: every SHOWN agent, whatever
   * the pool — so turning on Open rings the files the open agents touched,
   * without her having to tap anything. The agent window slider is the
   * control for how many that is; hiding agents empties it.
   *
   * Spotlighting one agent does NOT narrow this. The other agents' rings stay
   * on the map and recede with their own dots instead — the canvas fades
   * everything outside the spotlit footprint, rings included, so "whose work
   * is this" is still answerable about the rest of the map while one agent
   * holds the light. Dropping them outright made a click erase evidence
   * rather than quiet it.
   *
   * Prompt that produced it: "when i toggle "open" agents on, they don't show
   * rings around the files they've interacted with. i want them to show rings."
   */
  const ringSessionIds = shownAgentIds;

  /**
   * File → the touch it wears a ring for. One ring per file, so when several
   * agents have touched one file the loudest relationship wins
   * (agentTouchRings) — except on the spotlit agent's own files, where ITS
   * relationship wins instead. Same override the hovered agent already gets
   * in the canvas, for the same reason: while one agent is the subject, a
   * ring on its file has to say what THAT agent did, not what a louder
   * neighbour did.
   */
  const agentRings = useMemo(() => {
    if (!visible) return new Map<string, FileTouchKind>();
    const rings = agentTouchRings(visible.nodes, ringSessionIds);
    if (footprintSession) {
      for (const [id, kind] of sessionTouchRings(visible.nodes, footprintSession)) rings.set(id, kind);
    }
    return rings;
  }, [visible, ringSessionIds, footprintSession]);

  /**
   * The nodes that ARE the journal — what the pond landmark anchors over.
   *
   * The prefixes are the server's, verbatim (routes/pond.py JOURNAL_PATHS):
   * the card pool and the diary. Deliberately NOT all of `tulku/` — the vault
   * also holds threads, people files and docs, which are written *about* the
   * journal rather than being it, and the server already drew that line for
   * the working/journal split. This is the same line, so the map and the pond
   * can't disagree about where the water ends.
   */
  const pondNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of visible?.nodes ?? []) {
      if (n.kind !== 'file' || n.repoId !== 'vault' || !n.path) continue;
      if (n.path.startsWith('tulku/_system/data/cards/') || n.path.startsWith('tulku/tulku-diary/')) {
        ids.add(n.id);
      }
    }
    return ids;
  }, [visible]);

  // Where that cluster is sitting on screen, reported from the paint — it
  // moves with every pan, zoom and sim tick, none of which are React state.
  //
  // Assigned every render with no dep array, the same way onTap and
  // onHoverAgent are: this block sits ABOVE the effect that constructs the
  // engine, so a one-shot mount effect here would run against a null ref and
  // the callback would never be attached at all.
  const [pondAnchor, setPondAnchor] = useState<PondAnchor | null>(null);
  useEffect(() => {
    if (engineRef.current) engineRef.current.onPondMove = setPondAnchor;
  });
  useEffect(() => {
    engineRef.current?.setPondNodes(pondNodeIds);
  }, [pondNodeIds]);
  // The coil, handed over as an ORDER and a centre: the engine pins dot 0
  // innermost and winds the rest out from there (terrainCanvas.setCoils).
  useEffect(() => {
    // Each coil, handed over as an ORDER and a centre: the engine pins dot 0
    // innermost and winds the rest out from there (terrainCanvas.setCoils).
    // The caption is the line it wears under its own name — "1mo · 53 of
    // 685". Without it a centre is a control with no reading on it, and the
    // only way to know what tapping did is to count dots.
    engineRef.current?.setCoils(
      (coiled?.coils ?? []).map((coil) => ({
        folderId: coil.folderId,
        ids: coil.spiralIds,
        caption: `${coilWindowLabel(coil.windowDays)} · ${coil.shown} of ${coil.total}`,
        canPull: coil.pullTo !== undefined,
      })),
    );
  }, [coiled, coilWindows]);


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
    // `remember: true` is what makes re-opening this page reopen HER map:
    // positions, the nodes she dragged, and the camera are carried across the
    // mount in layoutMemory.ts. The ambient backdrop doesn't ask for it.
    const engine = new TerrainCanvas(canvas, initialInk, { remember: true });
    engineRef.current = engine;
    engine.setLineage(spinoffLinksRef.current);
    engine.setSwarms(swarmListRef.current);
    engine.onPins = setPinnedCount;
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

  // Tap. A FILE goes to a code tile if one is watching — in this window or
  // another browser window on another monitor (shell/panels/windowBus.ts),
  // most recently touched tile winning — and with no code tile anywhere it
  // opens straight into its full-screen code page, one tap, exactly
  // as before. Same rule as the observatory's file lists (SessionCard), so
  // code opens the same way from every surface. An AGENT ORB and a TABLE take
  // two clicks instead: the first picks the body out and lights what it holds
  // or what it's joined to, the second opens it (hoverSelection.ts tapStage).
  // Empty canvas clears everything. (Repo/dir hubs are structure, not
  // destinations — taps pass through.)
  //
  // Prompt: "have the terrain tab open in one browser window on one screen,
  // click a piece of code or an agent, and it opens on another screen" /
  // "clicking an agent highlights that agent and the files it's touching
  // rather than making a popup. i want a double click on the agents to make a
  // popup. same for the sql".
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    // A tap on a coil's tip curve. While it curves, it's a pull: the coil
    // widens to its next step — the first one that brings anything out
    // (coilFolders.ts pullTo) — and the engine pays the new dots out one at
    // a time. Once it's straight there's nothing left to pull, so it resets
    // the coil to its first step, the same as a tap on the centre.
    engine.onCoilTip = (folderId) => {
      const tipped = coiled?.coils.find((coil) => coil.folderId === folderId);
      if (!tipped) return;
      const to = tipped.pullTo === undefined ? tipped.collapseTo : tipped.pullTo;
      setCoilWindows((open) => ({ ...open, [tipped.prefix]: to }));
    };
    // The mouse over a coil's centre raises its card; the card owns the timing.
    engine.onHoverCoil = coilCard.hover;
    engine.onTap = (node, how) => {
      // A coil's centre collapses it: a tap on one of these folders closes
      // that coil back to its first step (a month, unless she's set it
      // otherwise) rather than selecting the folder. The widening lives on
      // the curve at the coil's tip — see onCoilTip above.
      //
      // A finger has no hover to raise the coil's card, so for touch the FIRST
      // tap on a centre opens the card (which carries a Collapse button) and
      // a second tap on the same centre collapses — the orbs' and tables'
      // pick-then-act. A tap anywhere else puts a finger-opened card away.
      const tappedCoil = coiled?.coils.find((coil) => coil.folderId === node?.id);
      if (tappedCoil) {
        const cardUp = coilCard.card?.pinned && coilCard.card.folderId === tappedCoil.folderId;
        if (how.pointerType !== 'mouse' && !cardUp) {
          const anchor = engine.screenAnchorOf(tappedCoil.folderId);
          if (anchor) coilCard.open(tappedCoil.folderId, anchor);
          return;
        }
        setCoilWindows((open) => ({ ...open, [tappedCoil.prefix]: tappedCoil.collapseTo }));
        coilCard.close();
        return;
      }
      if (coilCard.card?.pinned) coilCard.close();
      if (node?.kind === 'file') {
        // The pond tile isn't a code file — the landmark floating over it
        // owns the pond's interactions (its reach target catches most taps;
        // this catches the hit-slop ring around the square).
        if (node.path === POND_TILE_PATH) return;
        // A table isn't a code file either. TWO STAGES: the first click picks
        // it out and pins lit everything it's joined to — its foreign keys,
        // and the ropes to the code files that touch it — so she can read the
        // wiring without holding the mouse perfectly still. Clicking the
        // picked-out one again opens its card (columns, shape, joins, code).
        // A double-click does both in one gesture, which is the point: it's
        // two clicks on the same body either way, with no timer to wait out
        // and nothing that behaves differently under a finger.
        if (node.file?.table) {
          if (tapStage(node.id, heldTable) === 'open') {
            setSelected(node);
            return;
          }
          setSelected(null);
          setHeldTable(node.id);
          engine.holdFileHover(node.id);
          return;
        }
        if (node.path) {
          if (dispatchIntent({ kind: 'code', repo: node.repoId, path: node.path }) !== 'none') return;
          openCodeFile(node.repoId, node.path);
        }
      } else if (node?.kind === 'session' && node.session) {
        if (visitor) {
          // The orb's footprint rings on the map; the sheet's two "Open"
          // doors lead to the Observatory, which isn't theirs.
          setFootprintSession((cur) => (cur === node.session!.id ? null : node.session!.id));
          return;
        }
        // The same two stages the tables get. The first click spotlights the
        // agent and rings every file it has touched — which was already what a
        // tap did, with a card thrown over the top of it. The card is the
        // SECOND click now, so looking at an agent's territory doesn't cost
        // her a dismissal every time.
        if (tapStage(node.session.id, footprintSession) === 'open') {
          setSelected(node);
          return;
        }
        setSelected(null);
        setFootprintSession(node.session.id);
        setQuery(''); // the agent takes the spotlight over from the search
        acknowledge(node.session.id); // she turned to it — stop the sonar ping
      } else if (node === null) {
        // Empty map: put everything back. This is the way OUT of both
        // two-stage selections — clicking a picked-out body again opens it,
        // so it can't also be the way to un-pick it.
        setSelected(null);
        setFootprintSession(null);
        setHeldTable(null);
        engine.holdFileHover(null);
      }
    };
  });

  // Hover → the agent hovercard. Two delays, in opposite directions, and they
  // do different jobs:
  //
  //  · SHOW is delayed so sweeping the cursor across a cluster of orbs doesn't
  //    fire a card per orb. Once a card is up the pause has been paid, so
  //    moving between orbs swaps instantly.
  //  · HIDE is delayed so the card can be REACHED — leaving the orb starts a
  //    timer instead of dismissing, and the card cancels it by reporting the
  //    cursor's arrival (onEngage). Without this, the bare canvas between orb
  //    and card would dismiss the card every time she went for it.
  //
  // `hard` (a pan or zoom) skips the grace entirely: the orb has moved out from
  // under its own card, so there's nothing left to reach.
  //
  // Assigned every render (like onTap above) and closing over refs only, so it
  // never goes stale.
  const hoverTimerRef = useRef<number | null>(null);
  const hoverLeaveRef = useRef<number | null>(null);
  const hoverShownRef = useRef(false);
  const hoverEngagedRef = useRef(false);
  const clearHoverTimers = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (hoverLeaveRef.current !== null) {
      window.clearTimeout(hoverLeaveRef.current);
      hoverLeaveRef.current = null;
    }
  };
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.onHoverAgent = (next, hard) => {
      clearHoverTimers();
      if (next === null) {
        if (hard) {
          hoverShownRef.current = false;
          hoverEngagedRef.current = false;
          setHoverEngaged(false);
          setHover(null);
          return;
        }
        // She may be on her way into the card — it gets to say so before this
        // lands. If she's already in it, there's nothing to time out.
        if (hoverEngagedRef.current) return;
        hoverLeaveRef.current = window.setTimeout(() => {
          hoverLeaveRef.current = null;
          if (hoverEngagedRef.current) return;
          hoverShownRef.current = false;
          setHover(null);
        }, HOVER_LEAVE_MS);
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
  useEffect(() => () => clearHoverTimers(), []);

  // Live-mode flashes: any file whose newest touch advanced since the
  // previous payload glows for a second — the "watch it work" effect.
  // Compared on the COLLAPSED payload, so a new journal card advances the
  // pond tile's newest touch and the square itself flashes.
  const prevDataRef = useRef<TerrainData | null>(null);
  useEffect(() => {
    if (!collapsed) return;
    const prev = prevDataRef.current;
    prevDataRef.current = collapsed.data;
    if (!prev) return;
    const changed = changedFileIds(prev, collapsed.data);
    if (changed.size > 0) engineRef.current?.flash(changed);
  }, [collapsed]);

  // Code-weather: the flow feed (the same one /terrain/flow reads) rains new
  // writes onto the map — a few of the written lines rise off the file's node
  // and fade. Rides the same live gate as the heat poll; the engine seeds on
  // the first feed and only ever rains what's genuinely new, so this effect
  // can simply hand over every payload. Files below the current Files-slider
  // cut just have no node, and the engine skips them silently.
  //
  // Prompt: "This might be overlaid on the terrain visual though" (of the
  // watch-code-being-written surface).
  const flowData = useFlow(anyRunning && pageVisible, !visitor).data;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !flowData) return;
    engine.weather(
      flowData.events
        .filter((e) => e.snippet !== null)
        .map((e) => ({
          key: e.id,
          // Card files aren't nodes any more — the tile stands for all of
          // them, so a written card's lines rise off the pond itself.
          nodeId: parseCardPath(e.path)
            ? `${e.repo}:file:${POND_TILE_PATH}`
            : `${e.repo}:file:${e.path}`,
          lines: e.snippet!.split('\n'),
        })),
    );
  }, [flowData]);

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
    // A search owns the spotlight while it has hits: the matches stay lit
    // and captioned, everything else recedes. Labels in rank order, so
    // when the canvas thins captions it keeps the best matches.
    // Only the best few are captioned on the map: the list beside the field
    // already names every hit, and forty names over one directory is soup.
    if (searchIds) {
      engine.setFootprint(searchIds);
      engine.setFootprintLabels(searchHits.slice(0, SEARCH_LABEL_CAP).map((h) => h.id));
      return;
    }
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
  }, [footprintSession, visible, searchIds, searchHits]);

  useEffect(() => {
    engineRef.current?.setAgentRings(agentRings);
  }, [agentRings]);

  useEffect(() => {
    engineRef.current?.setPingingAgents(pingingAgents);
  }, [pingingAgents]);

  useEffect(() => {
    engineRef.current?.setLabeledAgents(labeledAgentIds);
  }, [labeledAgentIds]);

  // Hand the "Types" toggle to the canvas. The value is a toggle that stays
  // (typeColorPref.ts), so a terrain in another panel flips with this one.
  useEffect(() => {
    engineRef.current?.setTypeColors(typeColors);
  }, [typeColors]);

  // The dots the date range hides. Only worth computing while she's actually
  // narrowed it: unpinned, the range is the whole payload and nothing can be
  // outside it, and this walks every file in both repos.
  const hiddenByDates = useMemo(
    () =>
      collapsed && customRange
        ? filesOutsideRange(collapsed.data, range.from, range.to)
        : new Set<string>(),
    [collapsed, customRange, range.from, range.to],
  );

  // The one hidden set, and the date range is now its only contributor. Both
  // time filters that used to feed it are gone: heat colours instead of
  // cutting, and Active marks instead of hiding. What survives is the rule
  // that made them safe — the canvas skips painting these and moves nothing,
  // so a dot that comes back comes back to the same spot (terrainCanvas.ts
  // setHiddenFiles).
  const hiddenFiles = hiddenByDates;
  useEffect(() => {
    engineRef.current?.setHiddenFiles(hiddenFiles);
  }, [hiddenFiles]);
  // With both fires off there's nothing to judge staleness by, so the Types
  // view stops fading files and shows every type colour whole
  // (terrainCanvas.ts staleFade).
  useEffect(() => {
    engineRef.current?.setStaleFade(heatOn || goldOn);
  }, [heatOn, goldOn]);
  // What the Files dial's readout reports: dots actually PAINTED, so a cut
  // that hides half the map is visible in the number rather than only on the
  // canvas. Tables ride the map as synthetic files and aren't part of the
  // corpus count.
  const shownFiles = useMemo(
    () =>
      visible
        ? visible.nodes.filter(
            (n) => n.kind === 'file' && !n.file?.table && !hiddenFiles.has(n.id),
          ).length
        : 0,
    [visible, hiddenFiles],
  );

  const filterNote = useMemo(() => {
    if (!visible) return null;
    // Name what's taking dots off the map and how many that leaves. The date
    // range is the only thing that does now — the fire switches and windows
    // change colour, never what's on the map.
    if (hiddenByDates.size === 0) return null;
    const files = visible.nodes.filter((n) => n.kind === 'file' && !n.file?.days).length;
    return { title: 'Dates', count: `${files - hiddenFiles.size} of ${files} files` };
  }, [visible, hiddenFiles, hiddenByDates]);

  // Build the key's type list. Only the files drawn right now are counted,
  // so the legend never names a type that isn't on the map, and each swatch
  // is the exact lifted colour its dots wear (typeDotColor). The commonest
  // KEY_TYPE_ROWS named types are listed; "Other" closes the list whenever
  // anything is left over — unrecognised files or the types cut off the end.
  const typeRows = useMemo(() => {
    if (!typeColors || !ink || !visible) return null;
    const paths = visible.nodes
      // Tables ride the map as synthetic files, but they aren't a file type.
      .filter((n) => n.kind === 'file' && !n.file?.table && !hiddenFiles.has(n.id))
      .map((n) => n.path ?? n.label);
    const counts = fileTypeCounts(paths);
    const named = counts.filter((c) => c.type !== OTHER_FILE_TYPE);
    const listed = named.length < counts.length || named.length > KEY_TYPE_ROWS
      ? [...named.slice(0, KEY_TYPE_ROWS).map((c) => c.type), OTHER_FILE_TYPE]
      : named.map((c) => c.type);
    return listed.map((type) => ({
      label: type.label,
      color: typeDotColor(type.color, ink.bg, ink.text),
    }));
  }, [typeColors, ink, visible, hiddenFiles]);

  const toggleRepo = (repoId: string) => {
    setHiddenRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  // The open pair, in her words: HERE means this very page becomes the
  // conversation (inside a workspace tile, just that tile navigates); THERE
  // means the Observatory catches it wherever one is watching — a tile in
  // this window, or one on another monitor, over the window bus. The app
  // used to make this call silently (pane first, navigate as fallback); now
  // the fork is hers, on the button. "There" with no observatory watching
  // anywhere honestly collapses to "here" rather than doing nothing.
  //
  // Prompt: "i maybe want it to say 'open here' or 'open there' and 'there'
  // is the observatory and 'here' is that page".
  const openSessionHere = (convId: string) => {
    setSelected(null);
    void navigate(sessionLocation(convId));
  };
  const openSessionThere = (convId: string) => {
    if (openConversationInPane(convId)) {
      setSelected(null);
      return;
    }
    openSessionHere(convId);
  };

  // Files are read in the code pane now, not the sheet, so this is the age
  // line the PANE prints under the code.
  const codeFileLast = codeFile?.file ? fileLastTouch(codeFile.file) : null;

  // --- the agent hovercard ------------------------------------------------
  // Hide the hovercard whenever something covers the map. The agent sheet or
  // the file pane is up, so the cursor isn't over the map any more — a card
  // left hanging would be pointing at an orb she can't see.
  const hoverBlocked = selected !== null || codeFile !== null;
  // (No hovercard for a visitor: its facts come from the roster and the
  // session preview, neither of which is theirs to read.)
  const hoverId = hoverBlocked || visitor ? null : (hover?.id ?? null);
  // Fires only while she's actually pointing at one — cached per session, so
  // coming back to the same orb is instant.
  const hoverPreview = useSessionPreview(hoverId);
  const hoverFacts = useMemo(() => {
    if (hoverId === null) return null;
    const agent = rankedAgents.find((a) => a.id === hoverId);
    const meta = roster.data?.sessions.find((s) => s.id === hoverId);
    if (!agent && !meta) return null;
    // The dot's state comes from the ROSTER's own predicate, not a second rule
    // invented here — that's what makes a colour mean the same thing on the map
    // as it does on the Observatory. Only when the roster has never heard of
    // this session (archived since the map drew it) does the map's own
    // running flag stand in.
    const state: CardState = meta
      ? cardState(meta, openedMap()[hoverId])
      : agent?.running
        ? 'running'
        : 'rest';
    return {
      title: agent?.title || meta?.title || hoverId,
      state,
      meta,
      preview: hoverPreview.data,
    };
  }, [hoverId, rankedAgents, roster.data, hoverPreview.data]);

  // Pin the map's lighting to whichever agent has a card up, for as long as it
  // is up. The card sits off the canvas, so walking the cursor into it reads to
  // the engine as leaving the orb — and the footprint she's reading ABOUT would
  // go dark on the way to reading it. Pinning keeps the two halves of one
  // gesture lit together. Released when the card goes.
  useEffect(() => {
    engineRef.current?.holdHover(hoverId);
  }, [hoverId]);

  // The pointer arriving in the card / leaving it. Leaving re-arms the same
  // grace period the map's own leave uses, so a wobble off the card's edge and
  // back doesn't dismiss it.
  const engageHover = (engaged: boolean) => {
    hoverEngagedRef.current = engaged;
    setHoverEngaged(engaged);
    if (engaged) {
      clearHoverTimers();
      return;
    }
    hoverLeaveRef.current = window.setTimeout(() => {
      hoverLeaveRef.current = null;
      if (hoverEngagedRef.current) return;
      hoverShownRef.current = false;
      setHover(null);
    }, HOVER_LEAVE_MS);
  };

  // Opening from the card puts the session in the left pane and takes the card
  // away: the thing she wanted is now on screen beside the map, and a card
  // still hanging over the orb would just be in front of it.
  const dismissHover = () => {
    clearHoverTimers();
    hoverEngagedRef.current = false;
    hoverShownRef.current = false;
    setHoverEngaged(false);
    setHover(null);
  };

  // Typing a query takes the spotlight from whichever agent had it.
  const pickQuery = (q: string) => {
    setQuery(q);
    if (q.trim()) {
      setFootprintSession(null);
      setSelected(null);
    }
  };
  // A row in the hit list opens the file exactly as tapping its dot does:
  // out to a paired window if one is listening, else the full-screen code
  // page here (openCodeFile — the address finds the node, or stands one in).
  const openHit = (hit: TerrainSearchHit) => {
    if (dispatchIntent({ kind: 'code', repo: hit.repoId, path: hit.path }) !== 'none') return;
    openCodeFile(hit.repoId, hit.path);
  };

  return (
    <div className={[styles.page, guideOpen ? styles.guideOpen : ''].filter(Boolean).join(' ')}>
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

      {/* The embed view has no chrome at all (see `embed` above): both bars
          and the colour key stay unmounted, and one door floats bottom-right. */}
      {embed ? (
        <a className={styles.embedOpen} href="/terrain/map" target="_top" rel="noopener">
          Open Terrain <span aria-hidden="true">&#8599;</span>
        </a>
      ) : null}
      {embed ? null : (
      <>
      <TerrainGuide open={guideOpen} visitor={visitor} onClose={closeGuide} />
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
          {/* Find a file by name or path — the hits light on the map and
              list under the field; see TerrainSearch.tsx. */}
          <TerrainSearch query={query} onQuery={pickQuery} hits={searchHits} onPick={openHit} />
          {customRange ? (
            <button
              type="button"
              className={[styles.chip, styles.footprintChip].join(' ')}
              onClick={() => setCustomRange(null)}
            >
              dates · clear ×
            </button>
          ) : null}
          {/* The map is fetched when she ASKS now, not every time the page
              opens, so this chip is both the door to fresh data and the honest
              label of how old what she's looking at is. Beside it, and only
              when there's something to undo, the release: hand the nodes she
              dragged back to the physics.

              Prompt: "i want for the map to not have to reload every time i
              open the page ... there can be a button on there somewhere that i
              can actively refresh it." */}
          <div className={styles.mapTools}>
            {pinnedCount > 0 ? (
              <button
                type="button"
                className={[styles.chip, styles.releaseChip].join(' ')}
                title="Let the physics have the nodes you moved back"
                onClick={() => engineRef.current?.releasePins()}
              >
                release {pinnedCount}
              </button>
            ) : null}
            <button
              type="button"
              className={[styles.chip, styles.refreshChip, refreshing ? styles.refreshing : '']
                .filter(Boolean)
                .join(' ')}
              title={
                dataAge === null
                  ? 'Refresh the map'
                  : `Refresh the map — ${publishedSeconds ? 'published' : 'fetched'} ${
                      dataAge === 'now' ? 'just now' : `${dataAge} ago`
                    }`
              }
              aria-label="Refresh the map"
              disabled={refreshing}
              onClick={refreshMap}
            >
              <span className={styles.refreshGlyph} aria-hidden="true">
                &#8635;
              </span>
              {dataAge ? <span className={styles.refreshAge}>{dataAge}</span> : null}
            </button>
            {/* The Guide's door: beside the refresh chip because, like it, it
                is about the map rather than the work. Open for everyone —
                the panel itself says what a visitor can't reach. */}
            <button
              type="button"
              className={[styles.chip, styles.guideChip, guideOpen ? styles.chipActive : '']
                .filter(Boolean)
                .join(' ')}
              title="Guide — what the map shows and how to use it"
              aria-label="Guide"
              aria-expanded={guideOpen}
              onClick={() => (guideOpen ? closeGuide() : setGuideOpen(true))}
            >
              <span aria-hidden="true">?</span> Guide
            </button>
          </div>
          {/* Page tools, pushed to the right edge and away from the map's own
              controls: these act on the WORK, not on the map, so grouping them
              with the territory chips would say they filter something. The two
              shared panels hang from here (they anchor top-right by design). */}
          {visitor ? null : (
          <div className={styles.pageTools}>
            <button
              ref={notesBtnRef}
              type="button"
              className={[styles.chip, styles.iconChip].join(' ')}
              title="Terrain dev notes"
              aria-label="Terrain dev notes"
              aria-expanded={panel === 'notes'}
              onClick={() => togglePanel('notes')}
            >
              &#128221;
            </button>
            <button
              ref={schedBtnRef}
              type="button"
              className={[styles.chip, styles.iconChip].join(' ')}
              title="Schedule a prompt"
              aria-label="Schedule a prompt"
              aria-expanded={panel === 'schedule'}
              onClick={() => togglePanel('schedule')}
            >
              &#9200;
            </button>
            {/* The one door to every other room. It replaced a chip per room
                (📊 Attention, 🗄️ Data): at two rooms a row of labelled chips
                was already long, and more rooms are coming — so the doors
                moved into the rooms index, and the toolbar keeps a single
                labelled button however many rooms exist. Tapping it blurs the
                map and raises a card per room (TerrainRoomsIndex). */}
            <button
              type="button"
              className={[styles.chip, styles.roomChip, roomsOpen ? styles.chipActive : '']
                .filter(Boolean)
                .join(' ')}
              title="Rooms"
              aria-label="Rooms"
              aria-expanded={roomsOpen}
              onClick={() => setRoomsOpen((v) => !v)}
            >
              <span aria-hidden="true">&#128682;</span> Rooms
            </button>
            {/* Replay a captured journey on the map — record one here or in
                the Wiring room, then watch the dots flare in order. */}
            <button
              type="button"
              className={[styles.chip, journeyOpen ? styles.chipActive : ''].filter(Boolean).join(' ')}
              title="Journey — record and replay a path through the code"
              aria-expanded={journeyOpen}
              data-journey-ui=""

              onClick={() => setJourneyOpen((v) => !v)}
            >
              <span aria-hidden="true">&#9889;</span> Journey
            </button>
          </div>
          )}
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
            ramp={ink ? heatRamps(ink).ember : undefined}
            goldRamp={ink ? heatRamps(ink).gold : undefined}
            breathing={breathing}
            onBreathe={toggleBreathing}
            typeColors={typeColors}
            onTypeColors={setTypeColorsOn}
            heatOn={heatOn}
            onHeatOn={setHeatOn}
            activeOn={goldOn}
            onActiveOn={setGoldOn}
            heatAllTime={heatAllTime}
            onHeatAllTime={pickHeatAllTime}
            activeAllTime={cuts.activeAllTime}
            onActiveAllTime={pickActiveAllTime}
            activeSeconds={liveActiveSeconds}
            onActiveSeconds={pickActiveSeconds}
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
            hidden={agentsHidden}
            onHidden={setAgentsHiddenOn}
            spotlighted={footprintSession}
            onSpotlight={(id) => {
              setFootprintSession(id);
              setSelected(null);
              if (id) setQuery('');
              if (id) acknowledge(id); // tapping its row in the list counts too
            }}
          />
        </div>
        {/* The key holds the bottom-right corner. As a layout sibling it
            reserves its own width, which is what lets the controls beside it
            expand right up to its edge. */}
        {ink && !empty && !isLoading && !isError ? (
          <TerrainKey
            windowSeconds={windowSeconds}
            ink={ink}
            hidden={selected !== null || codeFile !== null}
            showAgents={shownAgentIds.size > 0}
            typeRows={typeRows}
            filterNote={filterNote}
          />
        ) : null}
      </div>

      </>
      )}

      {/* Rest the cursor on an agent orb and the Observatory's own card for that
          session floats up beside it — its dot, what she asked, what it's
          working on, what it last said — without her having to tap in and come
          back out. Keep going and the cursor lands IN the card: it holds still,
          the body scrolls down to the reply, and Open goes solid.
          See AgentHoverCard.tsx. */}
      {/* A coil's card: rest the mouse on a coil's centre, or tap it with a
          finger. See CoilHoverCard.tsx. */}
      <CoilHoverCard
        card={hoverBlocked ? null : coilCard.card}
        coil={coiled?.coils.find((coil) => coil.folderId === coilCard.card?.folderId)}
        readOnly={visitor}
        onEngage={coilCard.engage}
        onCollapse={() => {
          const coil = coiled?.coils.find((c) => c.folderId === coilCard.card?.folderId);
          if (coil) setCoilWindows((open) => ({ ...open, [coil.prefix]: coil.collapseTo }));
          coilCard.close();
        }}
        onClose={coilCard.close}
      />

      <AgentHoverCard
        hover={hoverBlocked || visitor ? null : hover}
        facts={hoverFacts}
        engaged={hoverEngaged}
        onEngage={engageHover}
        onOpenHere={() => {
          if (hoverId) {
            openSessionHere(hoverId);
            dismissHover();
          }
        }}
        onOpenThere={() => {
          if (hoverId) {
            openSessionThere(hoverId);
            dismissHover();
          }
        }}
      />

      {/* The pond, floating over the part of the terrain that is the journal —
          small and crude at rest, resolving when she reaches for it, and
          wearing whatever filters the pond itself is currently set to. Hidden
          while an overlay is up, for the same reason the agent hovercard is:
          it's anchored to a spot on a map she can no longer see. */}
      <PondLandmark
        anchor={roomsOpen || codeFile !== null || selected !== null ? null : pondAnchor}
        onReach={(reached) => engineRef.current?.setPondLit(reached)}
      />

      {/* Notes + timer panels. They position themselves top-right against the
          nearest positioned ancestor (.page), landing just under their trigger
          buttons in the top bar, and close themselves on Escape / a pointer
          down anywhere else — including on the canvas. */}
      {visitor ? null : (
      <>
      {/* Terrain's own dev notes. The panel is the shared one, but it files
          under the 'terrain' tab — not the 'terminal' list the Observatory and
          the terminal pane write to — so notes about the map stay with the map. */}
      <TermNotesPanel tab="terrain" open={panel === 'notes'} onClose={() => setPanel(null)} triggerRef={notesBtnRef} />
      <JourneyPanel
        open={journeyOpen}
        onClose={() => setJourneyOpen(false)}
        initialId={search.journey ?? null}
        playing={replay?.id ?? null}
        progress={replayProgress}
        onPlay={(req) => {
          // Pin every dot the journey lands on so the Files dial can't have
          // cut it away, then start once the graph has had a tick to rebuild.
          setReplayPins(beatNodeIds(req.beats));
          setReplay(null);
          window.setTimeout(() => setReplay(req), 250);
        }}
        onStop={() => {
          setReplay(null);
          setReplayThreads(null);
          setReplayProgress(null);
        }}
      />
      <SchedulePanel
        open={panel === 'schedule'}
        onClose={() => setPanel(null)}
        triggerRef={schedBtnRef}
        sessionNames={schedSessions}
      />
      {/* The hallway: map blurs, one opaque card per room, tap a card to go.
          Rendered above all the floating chrome (its backdrop covers the whole
          page), closed by Esc, the blur itself, or the Rooms button again. */}
      <TerrainRoomsIndex open={roomsOpen} onClose={() => setRoomsOpen(false)} />
      </>
      )}

      {/* The shared Sheet is for agents only. A tapped TABLE opens its own
          window below instead, because the Sheet centres on the whole browser
          window and a table's card has to centre over this pane. */}
      <Sheet
        open={selected !== null && !selected.file?.table}
        title={selected?.label}
        onClose={() => setSelected(null)}
      >
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
            {/* The same open pair the hovercard wears — here = this page,
                there = the Observatory, wherever one is watching. */}
            <div className={styles.openPair}>
              <button
                type="button"
                className={styles.sessionOpen}
                onClick={() => openSessionHere(selected.session!.id)}
              >
                <span className={styles.sessionTitle}>Open here</span>
                <span className={styles.sessionMeta}>this page</span>
              </button>
              <button
                type="button"
                className={styles.sessionOpen}
                onClick={() => openSessionThere(selected.session!.id)}
              >
                <span className={styles.sessionTitle}>Open there</span>
                <span className={styles.sessionMeta}>the Observatory</span>
              </button>
            </div>
            <div className={styles.sheetMeta}>
              Its footprint is ringed on the map — tap elsewhere to clear.
            </div>
          </div>
        ) : null}
      </Sheet>

      {/* The table window: what a tapped table opens — its description, and
          its actual rows with search (TerrainTableWindow). Centred over THIS
          pane, so with the screen split it sits over the map's side rather
          than straddling the divider. */}
      <TerrainTableWindow
        // Hide the card while a file is open over the map. The card sits
        // above the file pane, so it has to step aside — but it is hidden,
        // not closed, so going back from the file lands on the card she
        // opened it from.
        table={codeFile ? null : (selected?.file?.table ?? null)}
        allTables={tables?.tables ?? []}
        onClose={() => setSelected(null)}
        onPickTable={(tableName) => {
          // Jump to a joined table's card: same window, different table.
          const next = graph?.nodes.find((n) => n.file?.table?.name === tableName);
          if (next) setSelected(next);
        }}
        onOpenFile={(path, mentions) => {
          // Open one of the files that touches this table, the same way a
          // tapped dot opens: another window if one is listening, else the
          // code window here (openCodeFile — the file may not be ON the map,
          // and the address stands a bare node in when it isn't).
          //
          // The mentions travel with it either way, so the file opens where
          // it names this table rather than at line 1 — as a search param
          // wherever it lands.
          //
          // Opened HERE, the card is not closed, only hidden while the file
          // is up (see `table=` above): closing the file is "back", and back
          // from a file opened off a card should be that card. Handed to
          // another tile, the card closes as it always has.
          const repo = tables?.code_repo ?? 'skeleton';
          const label = selected?.file?.table?.name ?? '';
          if (dispatchIntent({ kind: 'code', repo, path, mentions, mentionsOf: label }) !== 'none') {
            setSelected(null);
            return;
          }
          openCodeFile(repo, path, mentions.length > 0 ? { label, lines: mentions } : undefined);
        }}
      />

      {/* The file pane: read the tapped file without leaving the map
          (FileCodeWindow). It covers this terrain panel's whole area and
          nothing outside it — one tile of a split, never its neighbours. The sim
          and the zoom transform are untouched while it's up, so closing it
          drops you back onto exactly the map you left. Under the code the
          pane carries what the MAP knows about the file: when it was last
          touched, and which agents touched it, each still able to ring its
          own footprint — the tail of the file, not a gate in front of it.
          The pane also gets the map's live heat window, gold window and
          ink, so its red-edits and gold-ran toggles (FileCodeBody) colour
          lines on the same lens as the dots — under Dynamic the lines
          breathe too. */}
      <FileCodeWindow
        repo={codeFile?.repoId ?? null}
        path={codeFile?.path ?? null}
        onClose={closeCodeFile}
        mentions={codeMentions ?? undefined}
        windowSeconds={windowSeconds}
        runWindowSeconds={liveActiveSeconds}
        ink={ink ?? undefined}
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
                    {/* Rows keep the quiet default — "there", the move that
                        preserves this window — the sheet's pair is where the
                        explicit fork lives. */}
                    <button
                      type="button"
                      className={styles.sessionOpen}
                      disabled={visitor}
                      title={visitor ? 'Sessions open only for the owner' : undefined}
                      onClick={() => {
                        if (!visitor) openSessionThere(s.id);
                      }}
                    >
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
                        closeCodeFile();
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
