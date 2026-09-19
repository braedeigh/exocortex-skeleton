/**
 * terrainCanvas.ts — the imperative canvas engine behind TerrainPage: a
 * d3-force layout drawn on a devicePixelRatio-scaled 2D canvas with d3-zoom
 * pan/pinch/wheel. Deliberately plain rendering glue (no tests — the logic
 * worth testing lives in terrainGraph.ts): React owns data + state and calls
 * setGraph/setTheme/setFootprint; this class owns the sim, the transform,
 * hit-testing, and the paint.
 *
 * Battery contract: the sim draws once per tick and goes fully quiet on
 * quiescence (d3-force's own 'end' event — no rAF loop ever idles). Pan/zoom
 * repaints without waking the sim; only a data change (lens, repo toggle,
 * fresh payload) re-warms it. The short-lived timers (flash halos, the
 * code-weather fade, the running-orb pulse) each die with the thing they
 * animate — none idles either.
 *
 * Heat encoding is redundant on purpose (dataviz skill): colour carries
 * recency AND node radius scales with the same glow. On the dark surface a
 * file dot is ASH (a neutral grey lifted off the page) with its hue laid over
 * it at an opacity equal to its glow — see the ramp block below for the
 * vocabulary (ash / ember / gold / glow / lean). The hot ends are hers: xterm
 * brightRed #f14c4c, "the color of the text printing into terminal", and
 * #ffd700 gold.
 *
 * Files are captioned only when an agent is spotlit, and then only its own
 * files — all of them above readable zoom, the dozen it touched most recently
 * below it. Before that, the eight hottest files were always labeled with
 * name + age; on the real map that read as arbitrary rather than informative,
 * because heat moves and so did which eight got named. A name now appears
 * because a gesture asked for it.
 *
 * Two gestures ask, and they ask for different amounts. HOVER (mouse only) is
 * a preview: put the cursor on an orb and every OTHER agent's dotted tethers
 * and file rings fall away, so the one under the cursor is the only agent
 * still speaking — the terrain underneath (heat, dots, hubs, tree edges) is
 * left exactly as it was. TAP is the commitment: the whole map dims to that
 * agent's footprint and its files caption themselves. Hover stands down while
 * a tap-spotlight is up, so the two never argue over the same pixels.
 *
 * Hover also reports OUT, through `onHoverAgent`: the conversation id plus
 * where its orb is sitting on screen right now, which is what /terrain hangs
 * its agent hovercard off (AgentHoverCard.tsx). The report is throttled to
 * actual movement of the orb, not of the cursor, so sitting still over one orb
 * costs nothing; a pan or zoom drops the hover outright — reported with the
 * `hard` flag, meaning "this one gets no grace period" — because the card would
 * otherwise be left pointing at where the orb used to be.
 *
 * The card is reachable now (you can move the cursor into it and click), which
 * the lighting has to survive: crossing the gap from orb to card takes the
 * cursor off the canvas, and the map would un-dim mid-journey. `holdHover`
 * pins the lighting to one agent for as long as its card is up, so the
 * footprint stays lit under the card she's reading it from.
 *
 * Prompt that produced the hover layer: "if you hover over an agent on
 * terrain, the other rings and lines become grayed out from the other agents
 * to focus on what is showing there."
 *
 * THE POND is one of two things on this map that aren't dots (the database's
 * tables, below, are the other). The card pool used
 * to arrive as ~1,700 anonymous dots; pondNodes.ts now swaps them for ONE
 * synthetic file node carrying the last month bucketed per day, and this
 * engine draws that node as a small square of water — one column per day,
 * each lit by its own dayHeat on the map's live lens, so the breath visibly
 * moves through the month. The tile is a real sim body with a collision
 * radius, so the rest of the terrain bumps around it rather than being
 * covered by it. It draws no text at any zoom: on the backdrop it's
 * wallpaper, and on /terrain the DOM landmark (PondLandmark.tsx) hangs its
 * name and its hover-pane off `onPondMove`, the same way the agent hovercard
 * hangs off `onHoverAgent`. The engine also tints the water under the pond
 * nodes, but only while she's looking at the landmark (`setPondLit`).
 *
 * Prompt that produced it: "I want the pond UI to display in the background
 * of my sessions ... in a square without any labels ... it needs to bump
 * around the other dots and not cover them".
 *
 * THE TABLES are the other. tableNodes.ts adds one synthetic file node per
 * database table, and this engine draws each as a rectangle that is the
 * table's own shape — one stripe per column wide, its row count tall — with a
 * foreign key drawn as a blue line to the table it points at (`drawTable`, the
 * 'fk' link kind). Each is a real sim body like the tile; unlike the tile they
 * name themselves, because a rectangle with no name teaches nothing. Hovering
 * one keeps the tables it's joined to lit; tapping one reports it through
 * `onTap` like any file, and the page shows its columns.
 *
 * Prompt that produced it: "i want them to be sized by how much is in there
 * and learn more about the shapes of the tables through this exercise".
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import {
  CREATED_FRESH_WINDOW_SECONDS,
  edgeKey,
  fileCreatedWithin,
  fileLastAgentWrite,
  graphUnchanged,
  normalizeHeat,
  writeFreshness,
  sessionTouchRings,
  SESSION_NODE_PREFIX,
  type FileTouchKind,
  type TerrainEdge,
  type TerrainNode,
} from './terrainGraph';
import type { TerrainThread } from './terrainThreads';
import { fileTypeOf } from './fileTypes';
import { COLUMN_WIDTH, HEADER_HEIGHT, tableCollideRadius, tableSize } from './tableNodes';

/**
 * THE TWO FIRES, in the words the map is built in (dark surface):
 *
 *   ASH   — the one cold end BOTH channels share: a NEUTRAL grey as bright
 *           as the page lifted a step toward ink, with the page's own hue
 *           taken out. Every file nothing has touched lately is ash. Derived
 *           live from the surface (readThemeInk), because the dark sky phases
 *           have four different backgrounds and a hardcoded grey would sit
 *           wrong on three of them. Neutral matters: the first cut kept the
 *           indigo tint, and red at half strength over purple-grey lands on
 *           mauve — the page's own family — so the eye filed every mid-heat
 *           ember as background and "the red wasn't showing up".
 *   EMBER — the red channel: this file was EDITED, per git. Hot end is the
 *           red her terminal prints in (xterm brightRed #f14c4c).
 *   GOLD  — the run channel: this code actually EXECUTED in the last day,
 *           per runtime_sensor.py (Python only — the browser half of a click
 *           is invisible to it). Fixed one-day window, whatever the Heat bar
 *           says (terrainGraph.ts RUN_WINDOW_SECONDS). Hot end #ffd700.
 *   GLOW  — how far off the floor a dot sits: the union of its ember and gold
 *           heats (1 - (1-t)(1-a)), so a little of each glows more than a
 *           little of one. Drives the dot's SIZE, whichever fire lit it.
 *   LEAN  — where between ember and gold the dot's hue sits: a / (t + a).
 *           Edited but never ran leans fully ember; ran but not edited in
 *           the window, fully gold; both, somewhere between — halfway is a
 *           clean orange, which honestly means "edited AND running". (The app's --orange is worn by agent orbs,
 *           which are stroked rings, not filled bodies, so the eye keeps them
 *           apart by structure.)
 *
 * A file dot is painted as an opaque ash disc with the lean hue laid over it
 * at an opacity of glowAlpha(glow) — the square root, not glow itself. A
 * single fresh touch normalises to a glow of ~0.5 (see normalizeHeat), and a
 * half-strength red over grey reads as dusty rose, not red; the curve puts
 * that same touch at ~0.7, where it still reads as the hue, and only the
 * truly cold tail sinks into ash. So the two fires never fight: they share a
 * floor, and as the Heat bar or the breath moves EMBER's window while gold
 * holds its day, a file that is both edited and running TURNS between the
 * hues rather than switching, and its red history is never hidden under a
 * gold body the way the old priority rule hid it.
 *
 * Gold used to mean "an agent had this file open" (the footprints sidecar).
 * Her call to retire that: the agent relationship still shows as the white
 * (read) and purple (modified) RINGS and the green write core; the body's
 * gold now says only "this ran".
 *
 * Everything else that paints heat (hubs, the pond, threads, the key, the heat
 * bar) reads the same two-stop ash→hue ramps through heatRamps(), so nothing
 * on the surface can disagree with the dots.
 *
 * Prompt that produced it: "i want for the red and the gold to not compete
 * ... each one is an opacity that fades to like a darker grey color against
 * the background" → "do ash. i want them to be opacity over the base ash
 * color".
 *
 * LIGHT MODE IS UNTOUCHED — still the old five-step ramps below (black cold
 * end, maroons, her red on top; the 1.47:1 hot-end failure on lavender is
 * known and kept by her call) and the old priority rule in the draw loop.
 * She has only looked at this on the dark surface so far.
 */
/** Ash sits this far from the page toward ink (in brightness only — the hue
 * is stripped, see readThemeInk). */
const ASH_LIFT = 0.16;

/** The opacity a glow paints at. Square-rooted so mid heats keep their hue
 * over ash (the dot block above says why); 0 stays 0 and 1 stays 1. Shared by
 * the dots and the ramps, so the key and heat bar can't disagree with the map. */
export function glowAlpha(glow: number): number {
  return Math.sqrt(Math.max(0, Math.min(1, glow)));
}
/** The hot ends — both hers. */
export const EMBER_HOT = '#f14c4c';
export const GOLD_HOT = '#ffd700';

/** The two ramps for a surface. Dark: ash → hue, sampled at five heats
 * through the same glowAlpha curve the dots use, so a colour read off the key
 * is the colour a dot of that heat actually wears. Light: the legacy
 * five-step ramps. heatColor() walks either. */
export function heatRamps(ink: ThemeInk): { ember: readonly string[]; gold: readonly string[] } {
  if (ink.dark) {
    const stops = [0, 0.25, 0.5, 0.75, 1];
    return {
      ember: stops.map((t) => mixHex(ink.ash, EMBER_HOT, glowAlpha(t))),
      gold: stops.map((t) => mixHex(ink.ash, GOLD_HOT, glowAlpha(t))),
    };
  }
  return { ember: HEAT_RAMP_LIGHT, gold: GOLD_RAMP_LIGHT };
}

/** Union of the two heats — a dot's height off the ash floor. */
export function glowOf(t: number, a: number): number {
  return 1 - (1 - t) * (1 - a);
}

/** 0 = fully ember, 1 = fully gold; 0 when neither fire is lit. */
export function leanOf(t: number, a: number): number {
  return t + a > 0 ? a / (t + a) : 0;
}
/**
 * The GOLD ramp for the LIGHT surface — the map's second channel: not "this
 * file was edited" (that's the red ramp below) but "this code RAN today".
 * Built to the same 5 steps, the same normalizeHeat, the same decay, so the
 * two channels are one language in two hues and a dot reads the same way in
 * either. (Dark builds its ramps live from ash — see heatRamps.)
 *
 * Gold rather than the lemon yellow this started as — her call, and it sits
 * better beside the terminal reds: #ffd700 is a warm hue-51 gold, a few degrees
 * off the ramp's own warmth rather than the greenish hue-95 of a pure yellow,
 * so the map reads as one fire in two temperatures instead of two unrelated
 * signals.
 *
 * Checked with the dataviz validator, not eyeballed. #ffd700 keeps the write
 * core legible on top of it (3.58:1, near-identical to the lemon's 3.71) and
 * scores the best tritan separation of the golds tried. The pair this ramp
 * CANNOT carry on hue alone is the core-green against a red dot elsewhere on
 * the map — ΔE 2.8 protan, indistinguishable — which is why the core is a small
 * concentric dot inside the body rather than a colour swap: a protanope tells
 * them apart by structure, a ring inside a disc vs a plain disc, and that
 * structural difference is load-bearing, not decoration.
 */
export const GOLD_RAMP_LIGHT = ['#201804', '#4d3a0a', '#8f6d10', '#c9a015', '#ffd700'] as const;

/**
 * The write core: a small filled dot at the centre of a file's body, saying an
 * agent WROTE here — full strength for the first hour, faded out by 24 (see
 * writeFreshness). Fed by the footprints sidecar (file.sessions), NOT by the
 * gold channel, so it lands on a red body or a gold one alike.
 *
 * A DEEP green, not the git-add green CREATED_GREEN wears, and the number is
 * the reason: #22c55e on the gold body measures 1.69:1 — invisible. This one
 * measures 3.71:1 against the same gold. The core's contrast partner is the
 * body it sits inside, not the page behind it, which is why it can't just reuse
 * the brighter green that works fine against a dark map.
 *
 * A filled core rather than the cross she first reached for: same idea, but a
 * cross is two thin strokes, and thin strokes are the first thing to dissolve
 * as a mark shrinks. A cold file's dot is 4px; a cross inside it is mush, while
 * a filled circle keeps its identity all the way down.
 */
const WRITE_CORE_GREEN = '#15803d';

export const HEAT_RAMP_LIGHT = ['#271513', '#681b1b', '#9b2425', '#cd3131', '#f14c4c'] as const;

/**
 * The agent's purple (her call, 07-26): the orb ring, its dotted tethers, AND
 * the files it has modified all share ONE purple — "this agent and what it
 * changed", spoken in a single colour. That purple is the app's --accent — the
 * same violet the map's dial thumbs wear — read live from the theme in
 * setTheme, so an install that retints --accent retints the agents with it.
 * AGENT_PURPLE below is only the fallback used before the first theme lands.
 * Reads stay white, heat stays red, and a file the agent CREATED fresh gets
 * its own green. Exported so the /terrain legend can decode the orb.
 */
export const AGENT_PURPLE = '#7c5cbf';
/** A file the focused agent has READ gets a white ring. */
const READ_RING = '#ffffff';
/** Freshly-created files (within 24h, anywhere on the map) fill their DOT
 * git-add green — her 07-27 call, moving "new" off the ring and onto the body
 * so it reads regardless of which agent is focused. The focused agent's own
 * created + modified files then both take the purple ring (this.orbStroke). */
const CREATED_GREEN = '#22c55e';

export interface ThemeInk {
  bg: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  accent: string;
  /** --evening (blue) — fallback identity token if --accent is ever
   * overridden into the red family (the heat ramp owns red). */
  evening: string;
  /** --orange — the app's one "something is waiting on you" tint (the roster's
   * ready dot, the orchestra's waiting cards). An agent that has done something
   * since she last opened it wears it out here too, so the map and the session
   * list raise a hand in the same colour. */
  orange: string;
  /** The shared cold floor of both heat ramps on the dark surface — a neutral
   * grey as bright as bg lifted ASH_LIFT toward ink. Computed for light too,
   * but only dark paints it. */
  ash: string;
  dark: boolean;
}

/** An agent orb under the cursor, located on screen. `x`/`y` are the orb's
 * CENTRE in client coordinates and `r` its drawn radius there, so the card can
 * clear the orb rather than sit on top of the thing being pointed at. */
export interface AgentHover {
  /** Conversation id — the same id the roster and the terrain payload use. */
  id: string;
  x: number;
  y: number;
  r: number;
}

/** Where the journal cluster sits on screen: its CENTRE in client coordinates
 * and the radius it covers there, so the landmark can float over the middle of
 * the water and know how much of the map it's standing on. */
export interface PondAnchor {
  x: number;
  y: number;
  r: number;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: TerrainNode;
  /** 0..1 normalized heat, precomputed once per setGraph. */
  t: number;
  /** 0..1 normalized RUN heat (the gold channel), same cadence as `t`.
   * 0 for everything that hasn't executed in the last day, which is most of
   * the map and every non-Python file. */
  a: number;
  radius: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  kind?: 'tree' | 'session' | 'fk';
}

/** One write worth raining on the map — key is the flow event's stable id,
 * nodeId the file node it rises from (`repo:file:path`). */
export interface WeatherDrop {
  key: string;
  nodeId: string;
  lines: string[];
}

/** One line of written code mid-flight above its file node. */
interface WeatherFrag {
  nodeId: string;
  text: string;
  /** Epoch-ms it starts rising — staggered within a drop, may be in the future. */
  born: number;
  /** Horizontal wander phase, so parallel fragments don't rise in lockstep. */
  seed: number;
}

const WEATHER_LIFE_MS = 4200;
const WEATHER_RISE_PX = 46;       // screen px risen over a lifetime
const WEATHER_STAGGER_MS = 480;   // gap between one drop's lines
const WEATHER_MAX_FRAGS = 36;     // cap on airborne fragments, map-wide
const WEATHER_LINES_PER_DROP = 3;
const WEATHER_MAX_CHARS = 44;     // a fragment is a glimpse, not a paragraph
const WEATHER_PX = 12;            // screen-locked, the app's text floor
const WEATHER_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Zoom floor. 0.2 was set when the map drew ~700 files; the Files dial now
 * reaches every file there is (~3,300), and that graph spreads far wider than
 * 0.2 can pull back from — fit() clamps against this floor, so the map would
 * overflow the viewport with no way to get out far enough to see it whole.
 * Low enough now to frame the full corpus on a phone with room to spare. */
const MIN_ZOOM = 0.03;
const MAX_ZOOM = 5;
/** Node radii are in WORLD units, so they shrink with the transform: at the
 * new floor a radius-3 file paints at 0.09px — i.e. a blank canvas. Every
 * node is drawn at least this many SCREEN pixels across, so zooming way out
 * yields a field of fine dots instead of nothing at all. */
const MIN_NODE_PX = 1.4;
/** Screen-space tap slop — a fingertip, not a cursor. */
const TAP_RADIUS_PX = 20;
/** "Readable zoom" — the line above which the map can afford names. Directory
 * hubs caption themselves here, and so does every file in a spotlit agent's
 * footprint. */
const LABEL_MIN_K = 0.7;
/** Below readable zoom a spotlit agent still names files, but only this many —
 * the ones it touched most recently. Enough to answer "what has it been
 * working on" without stacking forty 12px labels into soup. */
const FOOTPRINT_LABEL_CAP = 12;
/** Canvas text floor at default zoom — the app-wide 12px rule. Labels are
 * drawn in screen space, so they never shrink below this at any zoom. */
const LABEL_PX = 12;

/** The pond tile's square, in WORLD units — it scales with the territory like
 * any map object, unlike the DOM landmark (which is chrome). Sized like one
 * of the biggest file clusters on purpose: the journal is as large a
 * territory as any subsystem, and its body should say so. Her calls: "a
 * significant presence on the map. Maybe like the size of one of the
 * clusters", then "even bigger than it is now, but maybe not too much
 * bigger" (180 → 230). */
const POND_TILE_SIDE = 230;
/** ...but never smaller than this many SCREEN pixels — the tile is the
 * journal's whole presence on the map now, and at the far zoom floor even a
 * cluster-sized square would vanish. Same idea as MIN_NODE_PX. */
const POND_TILE_MIN_PX = 30;
/** Collision reach: the circle through the square's corners plus a little
 * margin. d3's colliders are circles, so dots clear the square's edges with
 * slightly more room than its corners — which reads as a margin, not a bug. */
const POND_TILE_COLLIDE_R = (POND_TILE_SIDE / 2) * Math.SQRT2 + 3;

/** Is this sim node the pond tile? (The one file node carrying day buckets —
 * see pondNodes.ts.) The physics treats it specially in three places: its
 * collision radius, its mooring spring, and its ballast in the tick. */
function isPondTile(n: SimNode): boolean {
  return n.node.file?.days !== undefined;
}

/** Is this sim node a database table? (A synthetic file carrying the table it
 * stands for — see tableNodes.ts.) Like the pond tile it is a body bigger than
 * a dot, so the physics gives it a collision circle, a longer rope to its
 * folder, and ballast. */
function isTable(n: SimNode): boolean {
  return n.node.file?.table !== undefined;
}

/** A table is never drawn narrower or shorter than this many SCREEN pixels, so
 * zooming far out leaves a field of small marks rather than nothing. Same idea
 * as MIN_NODE_PX. */
const TABLE_MIN_PX = 3;
/** Tables are named from further out than folders are (LABEL_MIN_K): there are
 * only a few dozen of them, and a rectangle with no name teaches nothing. */
const TABLE_LABEL_MIN_K = 0.3;
/** The smallest body a table gets in the physics, whatever its rectangle. */
const TABLE_MIN_COLLIDE_R = 30;

function hexToRgbTuple(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixHex(a: string, b: string, t: number): string {
  const ar = hexToRgbTuple(a);
  const br = hexToRgbTuple(b);
  const c = ar.map((v, i) => Math.round(v + (br[i] - v) * t));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

/** Piecewise-linear heat lookup across the 5 ramp steps. t=0 IS the black
 * end — "old = black" is the owner's mental model, so cold files never fade
 * into the surface; the coldest step itself is chosen per mode (near-black
 * ink on light, just-above-surface on dark). Exported so the heat slider can
 * paint the identical ramp along its own track — one lookup, so the control
 * and the map can never drift apart. */
export function heatColor(t: number, ramp: readonly string[]): string {
  if (t <= 0) return ramp[0];
  if (t >= 1) return ramp[ramp.length - 1];
  const u = t * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(u));
  return mixHex(ramp[i], ramp[i + 1], u - i);
}

function nodeRadius(node: TerrainNode, t: number): number {
  if (node.kind === 'repo') return 11;
  if (node.kind === 'session') return 9; // orbs: fixed — identity, not magnitude
  if (node.kind === 'dir') return 5.5 + 4.5 * t;
  // The pond tile: a body the size of its square, so the sim keeps the rest
  // of the map out from under it.
  if (node.file?.days) return POND_TILE_COLLIDE_R;
  // A table: the circle that encloses its rectangle, for the same reason.
  // Never less than TABLE_MIN_COLLIDE_R: a two-column lookup table is a sliver,
  // and slivers packed edge to edge leave no room for their names.
  if (node.file?.table) return Math.max(tableCollideRadius(node.file.table), TABLE_MIN_COLLIDE_R);
  return 4 + 9 * t; // file: GLOW (union of ember + gold) scales size — the redundant channel
}

// -- orb identity color: an app token, never a color from the heat ramp --

function relLuminance(hex: string): number {
  const s2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hexToRgbTuple(hex).map((v) => s2lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function wcagContrast(a: string, b: string): number {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab hue angle + chroma — used only to keep the orb accent away from
 * the heat ramp's red family (#cd3131/#f14c4c sit at hue ≈ 25°). */
function okHueChroma(hex: string): { hue: number; chroma: number } {
  const s2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hexToRgbTuple(hex).map((v) => s2lin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360, chroma: Math.hypot(a, bb) };
}

const RAMP_HUE = 25; // OKLab hue of the terminal reds
const RED_EXCLUSION_DEG = 30;

/** True when a color would read as red-family next to the heat ramp. */
function isReddish(hex: string): boolean {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
  const { hue, chroma } = okHueChroma(hex);
  if (chroma < 0.05) return false; // near-neutral can't read as red
  const d = Math.abs(((hue - RAMP_HUE + 540) % 360) - 180);
  return d <= RED_EXCLUSION_DEG;
}

/**
 * Session-orb stroke color: an identity token, NEVER a heat color. Takes
 * `primary` then `fallback` in preference order and returns the first that
 * isn't red-family (the ramp owns red) once nudged toward ink to clear 3:1 on
 * the live surface; if neither survives, plain ink.
 *
 * Orb identity is the app's --evening BLUE now, not the violet --accent — build
 * 2 gave purple a job (a file the agent MODIFIED gets a purple ring), and one
 * accent can't mean two things. Blue for the body, purple for what it changed,
 * white for what it read, red for heat: four signals that never collide.
 */
export function deriveOrbColor(primary: string, fallback: string, bg: string, text: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(bg)) return text;
  const candidates = [primary, fallback].filter((c) => /^#[0-9a-fA-F]{6}$/.test(c) && !isReddish(c));
  for (const base of candidates) {
    for (let f = 0; f <= 0.6001; f += 0.1) {
      const c = mixHex(base, text, f);
      if (wcagContrast(c, bg) >= 3 && !isReddish(c)) return c;
    }
  }
  return text;
}

/** How far a type colour has to stand off the surface to read as a dot. 3:1
 * is the WCAG floor for a graphic, the same bar the orb colour is held to. */
const TYPE_DOT_MIN_CONTRAST = 3;

/** A colour as OKLab — a colour space built so that equal steps look equally
 * big to the eye. L is lightness (0 black, 1 white); a and b together carry
 * the hue and how vivid it is. */
function hexToOklab(hex: string): [number, number, number] {
  const s2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hexToRgbTuple(hex).map((v) => s2lin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab back to a #rrggbb hex. A lightness the screen can't show at that
 * vividness is clipped channel by channel to the nearest colour it can. */
function oklabToHex(lightness: number, a: number, b: number): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin2s = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  const channels = [
    lin2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    lin2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    lin2s(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  return `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** How far lightness moves per try while lifting a type colour — fine enough
 * that the result lands just past the contrast floor, not well beyond it. */
const TYPE_DOT_LIGHTNESS_STEP = 0.02;

/**
 * Make a file type's colour legible on the live surface. Takes the type's
 * colour from fileTypes.ts and returns what the dot wears under the "Types"
 * toggle. A colour that already stands 3:1 off the surface is returned as it
 * is. One that doesn't — a navy on the dark sky, a pale yellow on the light
 * one — has ONLY its lightness moved, a step at a time toward the text ink's
 * lightness, until it clears 3:1. Hue and vividness are left alone, which is
 * the point: mixing toward the ink instead would grey every lifted colour
 * toward the same mud, and the types have to stay tellable apart. Exported so
 * the legend in TerrainPage.tsx shows exactly the colour the dot wears.
 */
export function typeDotColor(base: string, bg: string, text: string): string {
  const isHex = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);
  if (!isHex(base) || !isHex(bg) || !isHex(text)) return base;
  if (wcagContrast(base, bg) >= TYPE_DOT_MIN_CONTRAST) return base.toLowerCase();
  const [lightness, a, b] = hexToOklab(base);
  const step = hexToOklab(text)[0] > lightness ? TYPE_DOT_LIGHTNESS_STEP : -TYPE_DOT_LIGHTNESS_STEP;
  for (let next = lightness + step; next > 0 && next < 1; next += step) {
    const c = oklabToHex(next, a, b);
    if (wcagContrast(c, bg) >= TYPE_DOT_MIN_CONTRAST) return c;
  }
  return text;
}

/**
 * The sonar ping an agent that's waiting on her sends out: one orange ring
 * per period, launched from the orb's edge, expanding outward and fading as
 * it goes. Reach is in SCREEN pixels (divided by the transform at draw time)
 * so the ping travels the same visible distance at every zoom — a signal
 * meant to catch the eye shouldn't shrink to nothing when she pulls back to
 * see the whole map.
 */
const PING_PERIOD_MS = 2600;
const PING_REACH_PX = 26;

/**
 * How long the FOCUSED agent's purple ring takes to travel and fade. Unlike
 * the orange ping this one has no period of its own: the backdrop fires it at
 * both turns of the breath (see pulseFocusSonar), so the rhythm is the map's,
 * not a second clock beating against it. Rings therefore arrive 4s and 6s
 * apart; this is short enough to finish and leave silence inside even the
 * shorter gap, so two are never in flight at once.
 */
const FOCUS_SONAR_MS = 2200;

/** A stable 0..1 offset from a session id, so waiting orbs ping out of step
 * with each other. In unison several of them read as one strobing glitch;
 * staggered, each one reads as its own agent raising a hand. */
function stringPhase(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (((h % 1000) + 1000) % 1000) / 1000;
}

/** ~24ch truncation for orb title labels. */
function truncateLabel(s: string, max = 24): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export class TerrainCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sim: Simulation<SimNode, SimLink> | null = null;
  private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
  private transform: ZoomTransform = zoomIdentity;
  private simNodes: SimNode[] = [];
  private simLinks: SimLink[] = [];
  /**
   * The shape of the graph currently laid out — every node id, and every edge
   * as a key. Kept beside the sim purely so setGraph can ask "is this the same
   * map with different heat?" in one pass of lookups. Rewritten only when the
   * layout is actually rebuilt; the in-place path leaves both untouched,
   * because by definition it changed neither.
   */
  private nodeIds: Set<string> = new Set();
  private edgeKeys: Set<string> = new Set();
  private footprint: Set<string> | null = null;
  /**
   * The spotlit agent's files, ordered most-recently-touched first, and the
   * same ids as a set. Both are kept because the two zoom regimes ask
   * different questions: above readable zoom "is this file in the footprint"
   * (the set), below it "is this one of the newest few" (the list's head).
   */
  private footprintLabels: string[] = [];
  private footprintLabelSet: Set<string> = new Set();
  private theme: ThemeInk;
  private orbStroke = AGENT_PURPLE;
  private drawQueued = false;
  private destroyed = false;
  private width = 0;
  private height = 0;
  private fontFamily = 'system-ui, sans-serif';
  /** One-shot flash halos: node id → expiry epoch-ms. The timer lives only
   * until the last flash fades (~1s) — never idles. */
  private flashes = new Map<string, number>();
  /** Writer-to-reader threads between file dots, already lit (see
   * terrainThreads.ts). Empty until the page hands them over — the map draws
   * perfectly well without them. */
  private threads: readonly TerrainThread[] = [];
  /** The FILE dot under the cursor, when it has threads. Asking about one
   * file's wiring is a different question from asking about an agent, so it
   * gets its own hover rather than sharing hoverAgent's. */
  private hoverFile: string | null = null;
  /** Table node id → the table node ids it shares a foreign key with. */
  private foreignKeyKin = new Map<string, Set<string>>();
  /** Everything the hovered file is wired to, itself included — recomputed
   * only when the hover changes, not per frame. */
  private hoverFileKin: Set<string> = new Set();
  private flashTimer: number | null = null;
  /**
   * Code-weather: written lines rising off the file nodes as agents work —
   * ambient fragments, not readable prose (the readable stream is the Flow
   * lane, /terrain/flow; this is the same feed as atmosphere). Fragment list
   * + its fade timer, which — like the flash timer — lives only while
   * fragments are falling and never idles. `weatherSeen` keys off the flow
   * feed's stable event ids so a poll can only ever rain NEW writes; the
   * first feed after construction seeds it silently, so opening the map
   * doesn't replay hours of history as a storm.
   */
  private weatherFrags: WeatherFrag[] = [];
  private weatherTimer: number | null = null;
  private weatherSeen: Set<string> | null = null;
  /** Breathing pulse for running session orbs: a slow ~10fps interval, alive
   * ONLY while a running orb exists AND the document is visible — the
   * no-idle-animation guarantee holds when nothing is running or the PWA is
   * backgrounded. */
  private pulseTimer: number | null = null;
  private hasRunning = false;
  /**
   * Ambient mode — the map as *wallpaper* rather than as a page. No gestures,
   * no taps, no labels: behind a conversation, a filename is noise competing
   * with the thing she's actually reading. Used by the Observatory backdrop
   * (shell-side: TerrainBackdrop.tsx); /terrain itself never sets it.
   */
  private ambient = false;
  /**
   * Focus mode (backdrop-only): the conversation whose agent this surface is
   * standing behind. Its orb eases to loosely centered and the files it has
   * touched are ringed (white = read, purple = created-or-modified). Freshly
   * created files also fill their dot green, independent of focus. null on
   * /terrain, where the whole objective map is the point.
   */
  private focusConv: string | null = null;
  private focusRings: Map<string, FileTouchKind> = new Map();
  /**
   * The directories the focused agent is working INSIDE — every ancestor of
   * every file it has touched. Its own tier of caption in the Observatory's
   * step-back view, and the one that carries the most at a glance: "where is
   * it" survives being read in a second, where a list of filenames doesn't.
   * Derived alongside focusRings so it can never disagree with them.
   */
  private focusDirIds: Set<string> = new Set();
  /**
   * Whether this ambient surface is allowed to caption itself. Off by default
   * — wallpaper behind a conversation has no business naming things — and
   * turned on only while the step-back view is up, where the map has stopped
   * being wallpaper and become the thing she's looking at.
   */
  private ambientLabels = false;
  /**
   * The "Types" toggle: while on, every file dot is filled with its file
   * type's colour and nothing else — heat red, ran gold and new-file green
   * are all overridden. Size, rings and everything that isn't a file dot are
   * untouched.
   */
  private typeColors = false;
  /** Type colours already worked out for the current surface, keyed by
   * path — a cache, emptied whenever the theme changes, so the contrast
   * search in typeDotColor runs once per file rather than once per frame. */
  private typeColorCache: Map<string, string> = new Map();
  /**
   * File dots the All / Recent / Old switch has hidden (activityFilter.ts).
   * Hidden is a PAINT decision, not a layout one: these dots stay in the sim
   * and keep their places, so flipping the switch moves nothing — they just
   * aren't drawn, their tree edges and tethers and threads aren't drawn, and
   * a tap can't land on them.
   */
  private hiddenFiles: ReadonlySet<string> = new Set();
  /**
   * /terrain's ring set: every file the *shown* agents have read or written,
   * ringed all at once without anything being focused or tapped. Same colours
   * the backdrop's focus rings use (purple = written, white = read) and drawn
   * by the same code — kept in its own field because focusRings is bound to
   * the backdrop's single focused conversation and its camera easing, neither
   * of which /terrain wants.
   */
  private agentRings: Map<string, FileTouchKind> = new Map();
  /**
   * Conversations waiting on her — the roster's "ready" state, out here as an
   * orange sonar ping. Conversation ids, not orb ids. The page decides who
   * qualifies (unread, minus any she's already tapped); this class only draws
   * them and keeps the pulse loop alive while any of them is on screen.
   */
  private pingAgents: ReadonlySet<string> = new Set();
  /**
   * Which orbs draw their title. null = all of them (the backdrop, and any
   * caller that never sets it); a set = only these. /terrain passes the agents
   * active within the hour, so a wide pool stays present without becoming a
   * wall of names.
   */
  private labeledAgents: ReadonlySet<string> | null = null;
  /** Epoch-ms of the last focus sonar launch, 0 = never fired. The backdrop
   * sets this at each breath turn; the ring animates out from that instant. */
  private focusSonarAt = 0;
  /** Whether any orb currently ON the map is pinging — the other half, with
   * hasRunning, of "is there anything worth animating". */
  private hasPinging = false;
  /**
   * The agent under the cursor, if any — a conversation id, mouse-only. Purely
   * a lighting change: it never moves the camera, never touches the sim, and
   * costs one repaint when it changes. Touch pointers are ignored outright so
   * a tap can't leave a phone stuck in a hover it has no way to leave.
   */
  private hoverAgent: string | null = null;
  /**
   * The hovered agent's OWN read/write rings, cached until the hover or the
   * graph moves. Kept separate from agentRings because the two answer
   * different questions: agentRings says "the strongest thing any shown agent
   * did to this file", which is right for the resting map but wrong the moment
   * she asks about one agent — hovering should say what THIS one did to it,
   * even if a louder agent also wrote it.
   */
  private hoverRings: Map<string, FileTouchKind> = new Map();
  /** The last hover reported to `onHoverAgent`, so a cursor resting on one orb
   * doesn't fire a report (and a React render) per pointermove. */
  private hoverReport: AgentHover | null = null;
  /** An agent whose lighting is pinned on regardless of where the cursor is —
   * set while its hovercard is up. See holdHover. */
  private heldHover: string | null = null;
  /**
   * The nodes that ARE the journal — the card pool and the diary, by the same
   * path prefixes routes/pond.py calls JOURNAL_PATHS. Their centroid is where
   * the pond landmark anchors itself, so the little pond floats over the part
   * of the terrain it's a picture of rather than at some fixed corner.
   *
   * A set of ids rather than a computed region: which files count as the
   * journal is a decision the server already made, and re-deriving it here
   * from paths would be a second copy of that rule free to drift from the
   * first.
   */
  private pondIds: ReadonlySet<string> | null = null;
  /** Whether to tint the water under those nodes — on only while she's
   * actually looking at the landmark. */
  private pondLit = false;
  /** The last anchor reported, so a still map costs no React renders. */
  private pondReport: PondAnchor | null = null;

  onTap: ((node: TerrainNode | null) => void) | null = null;
  /**
   * Where the hovered agent's orb is on screen, in client coordinates — the
   * anchor /terrain hangs its hovercard from. null the moment the cursor
   * leaves the orb, or the map moves under it.
   */
  onHoverAgent: ((hover: AgentHover | null, hard?: boolean) => void) | null = null;
  /**
   * Where the journal cluster is sitting on screen right now, in client
   * coordinates — what the pond landmark hangs off, the same way the agent
   * hovercard hangs off `onHoverAgent`. null when no journal files are drawn
   * (the vault hidden, or the Files dial cut below them).
   *
   * Reported from the paint rather than from React, because the position is a
   * fact about the sim and the transform, and both move without any state
   * changing. Throttled to a pixel of actual movement.
   */
  onPondMove: ((anchor: PondAnchor | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, theme: ThemeInk, opts?: { ambient?: boolean }) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.theme = theme;
    this.ambient = opts?.ambient === true;
    this.fontFamily =
      getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || this.fontFamily;

    this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .clickDistance(8) // pans suppress the click; taps still land
      .on('zoom', (event: { transform: ZoomTransform }) => {
        this.transform = event.transform;
        // The map just moved out from under the cursor. A wheel-zoom fires no
        // pointermove, so nothing else would correct a hovercard still hanging
        // where the orb used to be — drop the hover and let her point again.
        if (this.hoverAgent !== null || this.hoverReport !== null || this.heldHover !== null) {
          this.holdHover(null);
          this.setHoverAgent(null);
          this.reportHover(null, true);
        }
        this.requestDraw(); // repaint only — pan/zoom never wakes the sim
      });
    // An ambient canvas binds neither: every gesture over the Observatory
    // belongs to the conversation, and a backdrop that ate a swipe would read
    // as the page being broken.
    if (!this.ambient) {
      select(this.canvas).call(this.zoomBehavior);
      this.canvas.addEventListener('click', this.handleClick);
      this.canvas.addEventListener('pointermove', this.handlePointerMove);
      this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    }

    document.addEventListener('visibilitychange', this.handleVisibility);
    this.orbStroke = theme.accent; // agent + its dotted tethers = the app --accent (her 07-26 call)
  }

  destroy(): void {
    this.destroyed = true;
    this.sim?.stop();
    this.stopPulse();
    if (this.flashTimer !== null) {
      window.clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.weatherTimer !== null) {
      window.clearInterval(this.weatherTimer);
      this.weatherTimer = null;
    }
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    select(this.canvas).on('.zoom', null);
  }

  /** CSS-pixel size from the layout; backing store scales by DPR. */
  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.requestDraw();
  }

  setTheme(theme: ThemeInk): void {
    this.theme = theme;
    this.orbStroke = theme.accent; // agent + its dotted tethers track the live --accent
    this.typeColorCache.clear(); // type colours are lifted against the surface, which just changed
    this.requestDraw();
  }

  /** Turn the "Types" colouring on or off (typeColorPref.ts). Pure lighting:
   * no camera move, no sim wake, one repaint when it flips. */
  setTypeColors(on: boolean): void {
    if (this.typeColors === on) return;
    this.typeColors = on;
    this.requestDraw();
  }

  /** Hand over the file dots to hide (activityFilter.ts). Pure lighting: no
   * camera move, no sim wake, one repaint. */
  setHiddenFiles(ids: ReadonlySet<string>): void {
    this.hiddenFiles = ids;
    this.requestDraw();
  }

  setFootprint(footprint: Set<string> | null): void {
    this.footprint = footprint;
    this.requestDraw();
  }

  /** File node ids for the spotlit agent, most-recently-touched first (see
   * sessionFootprintByRecency). Pass an empty array when nothing is spotlit —
   * files are captioned only for an agent she's actually asked about. */
  setFootprintLabels(orderedIds: string[]): void {
    this.footprintLabels = orderedIds;
    this.footprintLabelSet = new Set(orderedIds);
    this.requestDraw();
  }

  /** The shown agents' read/write rings (see agentTouchRings). Pass an empty
   * map to clear. */
  setAgentRings(rings: Map<string, FileTouchKind>): void {
    this.agentRings = rings;
    this.requestDraw();
  }

  /**
   * Launch one purple ring from the focused agent's orb, now. The backdrop
   * calls this at each turn of the breath — the top, where the map stops
   * widening its memory and starts letting it go, and the bottom, where it
   * turns back — so the agent's signal rides the terrain's rhythm instead of
   * running on a clock of its own.
   *
   * Prompt that produced it: "make the purple ping at the switch between grow
   * and shrink for the heat map" → "do the pulse at both the top and the
   * bottom of the breath cycle".
   */
  pulseFocusSonar(): void {
    this.focusSonarAt = Date.now();
    this.requestDraw();
  }

  /** One sonar ring: launched from the orb's edge, travelling outward, fading
   * faster than linearly (the ^1.7) so it dissolves near the end of its travel
   * rather than vanishing mid-stride. `p` is 0..1 through the ring's life. */
  /** The write core — an agent WROTE here, and how long ago. Full green for
   * the first hour, then shrinking and dimming until it's gone at 24h, so
   * "just now" and "yesterday morning" are the same mark at two strengths
   * rather than two things to learn. Drawn inside the body, so it only ever
   * appears on a dot the gold channel has already claimed.
   *
   * Skipped below ~7px on screen: at a cold dot's 4px there is no room for a
   * centre that still reads as a centre, and a smudge that says "written" is
   * worse than no mark at all. */
  private drawWriteCore(n: SimNode, nr: number, now: number): void {
    if (!n.node.file?.sessions?.length || nr * this.transform.k < 7) return;
    const fresh = writeFreshness(fileLastAgentWrite(n.node.file, now / 1000));
    if (fresh <= 0) return;
    const { ctx } = this;
    // Multiply into whatever alpha the dimming rules already set rather than
    // overwriting it — a dimmed dot's core has to dim with it.
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * (0.35 + 0.65 * fresh);
    ctx.fillStyle = WRITE_CORE_GREEN;
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, nr * (0.22 + 0.24 * fresh), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = base;
  }

  private strokeSonar(x: number, y: number, r: number, color: string, p: number, alpha: number): void {
    const { ctx, transform } = this;
    ctx.globalAlpha = alpha * 0.8 * (1 - p) ** 1.7;
    ctx.strokeStyle = color;
    ctx.lineWidth = (1 + 1.4 * (1 - p)) / transform.k;
    ctx.beginPath();
    ctx.arc(x, y, r + (PING_REACH_PX * p) / transform.k, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Which orbs caption themselves. Pass null for "every orb". */
  setLabeledAgents(ids: ReadonlySet<string> | null): void {
    this.labeledAgents = ids;
    this.requestDraw();
  }

  /** Which conversations send the orange sonar ping — the ones waiting on her
   * that she hasn't acknowledged yet. */
  setPingingAgents(ids: ReadonlySet<string>): void {
    this.pingAgents = ids;
    this.refreshPinging();
    this.requestDraw();
  }

  /** Is any orb actually drawn right now pinging? Recomputed whenever either
   * side of that question moves — the ping set, or the node set. */
  private refreshPinging(): void {
    this.hasPinging = this.simNodes.some(
      (sn) =>
        sn.node.kind === 'session' &&
        sn.node.session !== undefined &&
        sn.node.session.running !== true &&
        this.pingAgents.has(sn.node.session.id),
    );
    this.updatePulseLoop();
  }


  /**
   * Focus the map on one conversation's agent (backdrop-only). Its orb eases
   * to loosely centered, the files it has touched are ringed — white = read,
   * purple = created-or-modified — and the camera frames the orb plus that working set,
   * honestly: the files stay where they really live in the tree (option A),
   * only the viewport moves. null clears focus and returns to whole-graph
   * framing.
   */
  setFocus(convId: string | null): void {
    if (this.focusConv === convId) return;
    this.focusConv = convId;
    this.recomputeFocusRings();
    this.requestDraw();
  }

  /** Let an ambient surface caption itself (the Observatory's step-back view).
   * Pure lighting: no camera move, no sim wake, one repaint when it flips. */
  setAmbientLabels(on: boolean): void {
    if (this.ambientLabels === on) return;
    this.ambientLabels = on;
    this.requestDraw();
  }

  private recomputeFocusRings(): void {
    this.focusRings = this.focusConv
      ? sessionTouchRings(this.simNodes.map((sn) => sn.node), this.focusConv)
      : new Map();
    // Walk up from each touched file to collect the directories it sits in.
    // Ancestors rather than immediate parents: a file at features/terrain/x.ts
    // means the agent is working in features/ as much as in features/terrain/,
    // and the collapsed-chain labels the graph builds ("routes/kitchen") read
    // naturally at either level. Stops climbing the moment it reaches a
    // directory already collected, so shared ancestors are walked once.
    const dirs = new Set<string>();
    if (this.focusRings.size > 0) {
      const parentOf = new Map<string, string | null>();
      const kindOf = new Map<string, TerrainNode['kind']>();
      for (const sn of this.simNodes) {
        parentOf.set(sn.id, sn.node.parentId);
        kindOf.set(sn.id, sn.node.kind);
      }
      for (const fileId of this.focusRings.keys()) {
        let p = parentOf.get(fileId) ?? null;
        while (p !== null && !dirs.has(p)) {
          if (kindOf.get(p) === 'dir') dirs.add(p);
          p = parentOf.get(p) ?? null;
        }
      }
    }
    this.focusDirIds = dirs;
  }

  /** The transform that loosely centers the focused orb + its ringed files in
   * view, or null when there's nothing to frame yet (agent hasn't touched a
   * file, so it has no orb). Files keep their true tree positions — this only
   * decides where the camera looks.
   *
   * The POND is always in the frame. A focused camera used to crop to the
   * agent's own corner of the map, which put the water off-screen behind most
   * sessions; the journal is a permanent landmark, so the frame now widens to
   * hold the agent's territory AND the whole tile (its full square, not just
   * its centre). Her ask: "make it show in the background on all of the
   * sessions." */
  private computeFocusTransform(): { x: number; y: number; k: number } | null {
    if (!this.focusConv) return null;
    const wanted = new Set<string>([`${SESSION_NODE_PREFIX}${this.focusConv}`, ...this.focusRings.keys()]);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let found = false;
    for (const n of this.simNodes) {
      if (!wanted.has(n.id)) continue;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      found = true;
    }
    if (!found) return null;
    // Only once the agent gives the camera something to frame — the tile
    // alone must not conjure a focus frame on a session with no orb yet
    // (that session already shows the whole map, pond included).
    for (const n of this.simNodes) {
      if (!isPondTile(n)) continue;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      minX = Math.min(minX, x - n.radius); maxX = Math.max(maxX, x + n.radius);
      minY = Math.min(minY, y - n.radius); maxY = Math.max(maxY, y + n.radius);
    }
    const pad = 90;
    const w = Math.max(1, maxX - minX) + pad * 2;
    const h = Math.max(1, maxY - minY) + pad * 2;
    const k = Math.max(MIN_ZOOM, Math.min(1.2, this.width / w, this.height / h));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { x: this.width / 2 - cx * k, y: this.height / 2 - cy * k, k };
  }

  /**
   * One eased step of the focus camera toward its target, re-requesting frames
   * until it settles, then stopping — no idle loop. The target is recomputed
   * from live node positions each call, so the camera tracks the agent's
   * cluster while the sim moves (or new files light) and holds still the moment
   * everything quiesces. Backdrop-only: it sets `this.transform` directly
   * rather than through d3-zoom, which is safe because ambient surfaces bind no
   * gestures to diverge from.
   */
  private stepFocusCamera(): void {
    const target = this.computeFocusTransform();
    if (!target) return;
    const cur = this.transform;
    const dx = target.x - cur.x;
    const dy = target.y - cur.y;
    const dk = target.k - cur.k;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dk) < 0.0005) {
      this.transform = zoomIdentity.translate(target.x, target.y).scale(target.k);
      return;
    }
    const e = 0.16; // a loose follow, not a snap
    this.transform = zoomIdentity
      .translate(cur.x + dx * e, cur.y + dy * e)
      .scale(cur.k + dk * e);
    if (document.visibilityState === 'visible') this.requestDraw();
  }

  /**
   * Hand over the file-to-file threads, already heated on the page's live lens.
   * Cheap to call every breath tick: this only stores the array and asks for a
   * repaint, and the sim never sees these at all — a thread is a thing drawn
   * BETWEEN two dots, never a force pulling them together. Letting them into
   * the physics would drag unrelated directories into each other and quietly
   * destroy the one thing the tree layout is for.
   */
  setThreads(threads: readonly TerrainThread[]): void {
    this.threads = threads;
    // The breath re-lights these ~7x/s. If she's hovering while that happens,
    // the kin set has to be rebuilt against the new array or the highlight
    // would go on pointing at threads that no longer exist.
    if (this.hoverFile !== null) this.recomputeHoverKin();
    this.requestDraw();
  }

  /** Which nodes the hovered file is threaded to. Recomputed on a hover change
   * or a thread refeed — never in the draw loop, which runs far more often. */
  private recomputeHoverKin(): void {
    const kin = new Set<string>();
    const id = this.hoverFile;
    if (id !== null) {
      kin.add(id);
      for (const th of this.threads) {
        if (th.sourceId === id) kin.add(th.targetId);
        else if (th.targetId === id) kin.add(th.sourceId);
      }
      // A hovered table keeps the tables it's joined to lit beside it.
      for (const other of this.foreignKeyKin.get(id) ?? []) kin.add(other);
    }
    this.hoverFileKin = kin;
  }

  /** Point the thread highlight at a file dot, or clear it. Only files that
   * actually have threads — or tables that actually have foreign keys — take
   * the hover: lighting up a dot with nothing wired to it would dim the whole
   * map to say nothing. */
  private setHoverFile(id: string | null): void {
    let next = id;
    if (
      next !== null &&
      !this.foreignKeyKin.has(next) &&
      !this.threads.some((th) => th.sourceId === next || th.targetId === next)
    ) {
      next = null;
    }
    if (next === this.hoverFile) return;
    this.hoverFile = next;
    this.recomputeHoverKin();
    this.requestDraw();
  }

  /**
   * One-shot ~1s flash on the given node ids (live mode: files whose newest
   * touch advanced since the previous payload). A short interval repaints
   * the fade and clears itself when the last flash expires.
   */
  flash(ids: Set<string>): void {
    if (ids.size === 0 || this.destroyed) return;
    const until = Date.now() + 1000;
    for (const id of ids) this.flashes.set(id, until);
    if (this.flashTimer === null) {
      this.flashTimer = window.setInterval(() => {
        const now = Date.now();
        for (const [id, expiry] of this.flashes) {
          if (expiry <= now) this.flashes.delete(id);
        }
        if (this.flashes.size === 0 && this.flashTimer !== null) {
          window.clearInterval(this.flashTimer);
          this.flashTimer = null;
        }
        this.requestDraw();
      }, 80);
    }
    this.requestDraw();
  }

  /**
   * Feed the code-weather: the flow feed's current events (see WeatherDrop).
   * New events — never-seen keys — shed their first few lines as fragments
   * that rise off their file's node and fade; everything already seen is
   * ignored, so calling this on every poll is free. The very first call
   * only seeds the seen-set: history isn't weather.
   */
  weather(drops: WeatherDrop[]): void {
    if (this.destroyed) return;
    if (this.weatherSeen === null) {
      this.weatherSeen = new Set(drops.map((d) => d.key));
      return;
    }
    const now = Date.now();
    let spawned = false;
    for (const drop of drops) {
      if (this.weatherSeen.has(drop.key)) continue;
      this.weatherSeen.add(drop.key);
      // A hidden page spawns nothing (the fragments would be long dead by the
      // time she looked), but the key is still marked seen above — returning
      // to the map resumes the present, it doesn't replay the absence.
      if (document.visibilityState !== 'visible') continue;
      const lines = drop.lines
        .map((l) => l.trim())
        .filter((l) => l.length > 1)
        .slice(0, WEATHER_LINES_PER_DROP);
      for (let i = 0; i < lines.length; i++) {
        if (this.weatherFrags.length >= WEATHER_MAX_FRAGS) break;
        this.weatherFrags.push({
          nodeId: drop.nodeId,
          text: lines[i].length > WEATHER_MAX_CHARS ? `${lines[i].slice(0, WEATHER_MAX_CHARS)}…` : lines[i],
          born: now + i * WEATHER_STAGGER_MS,
          seed: Math.random() * Math.PI * 2,
        });
        spawned = true;
      }
    }
    // The seen-set tracks the feed's own window (server caps it): ids age out
    // of the payload and never return, so mirroring the feed keeps it bounded.
    const live = new Set(drops.map((d) => d.key));
    for (const key of this.weatherSeen) if (!live.has(key)) this.weatherSeen.delete(key);

    if (spawned && this.weatherTimer === null) {
      // ~30fps is plenty for drifting text, and the timer dies with the last
      // fragment — same never-idles contract as the flash timer above.
      this.weatherTimer = window.setInterval(() => {
        const cutoff = Date.now();
        this.weatherFrags = this.weatherFrags.filter((f) => cutoff - f.born < WEATHER_LIFE_MS);
        if (this.weatherFrags.length === 0 && this.weatherTimer !== null) {
          window.clearInterval(this.weatherTimer);
          this.weatherTimer = null;
        }
        this.requestDraw();
      }, 33);
    }
  }

  // -- pulse loop management (running orbs only, visible page only) --

  private handleVisibility = (): void => {
    this.updatePulseLoop();
  };

  private updatePulseLoop(): void {
    // Two things earn the loop: a running orb's undulation, and a waiting
    // orb's sonar ping. Waiting is a much more common state than running, so
    // this animates more of the time than the original battery contract
    // implied — still never while the page is hidden, and still nothing at all
    // when no agent is either working or asking for her (her 07-27 call:
    // "an orange sonar ping that comes out from it until i click it").
    const want =
      (this.hasRunning || this.hasPinging) && !this.destroyed && document.visibilityState === 'visible';
    if (want && this.pulseTimer === null) {
      this.pulseTimer = window.setInterval(() => this.requestDraw(), 100);
    } else if (!want) {
      this.stopPulse();
    }
  }

  private stopPulse(): void {
    if (this.pulseTimer !== null) {
      window.clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  /**
   * Swap in a (re)built graph. Positions carry over by node id so a lens
   * change or repo toggle re-warms a settled layout instead of exploding a
   * fresh one; brand-new nodes seed near their parent (session orbs amid
   * their footprint). When the node/edge sets are UNCHANGED (a live-mode
   * refetch that only advanced heats/labels/running flags, or a lens change
   * on the same files), the sim nodes update in place and the layout never
   * re-warms — the map holds still while its glow shifts.
   *
   * That last sentence is the expensive one to get wrong, and it was wrong for
   * a while: the "unchanged" test compared a node COUNT against the size of a
   * Map keyed by id, and the graph was handing back duplicate directory ids,
   * so the two could never agree and the fast path never ran. Under the
   * backdrop's breath that meant tearing down and re-running the force layout
   * seven times a second over a few thousand bodies, which saturates a core
   * and — because each rebuild re-warms alpha long before the previous one
   * could settle — means the map never actually goes still or goes to sleep.
   * The test now lives in terrainGraph.ts as graphUnchanged, where it is a
   * pure function with tests on it, for exactly that reason.
   */
  setGraph(nodes: TerrainNode[], edges: TerrainEdge[]): void {
    // The shape test reads the id/key sets kept alongside the sim rather than
    // re-deriving them from simNodes/simLinks each call — this runs ~7x a
    // second under the backdrop's breath, and rebuilding two collections of a
    // few thousand entries just to ask "did anything move" was most of the
    // cost of asking. See graphUnchanged in terrainGraph.ts for why the test
    // itself lives over there.
    if (graphUnchanged(this.nodeIds, this.edgeKeys, nodes, edges)) {
      // Same bodies, new heats: update in place, leave the layout alone. The
      // lookup is a Map and not nodes.find() — find() inside this loop is a
      // scan per node, which is the same O(n^2) the graph's duplicate-id bug
      // was already hiding behind, and at a few thousand nodes it costs as
      // much as the full rebuild it exists to avoid.
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const sn of this.simNodes) {
        const node = byId.get(sn.id);
        if (!node) continue;
        sn.node = node;
        sn.t = normalizeHeat(node.heat);
        sn.a = normalizeHeat(node.runHeat ?? 0);
        sn.radius = nodeRadius(node, glowOf(sn.t, sn.a));
      }
      this.refreshDerived(nodes);
      this.requestDraw();
      return;
    }

    const prev = new Map(this.simNodes.map((n) => [n.id, n]));
    const repoIds = [...new Set(nodes.filter((n) => n.repoId).map((n) => n.repoId))];
    const anchorFor = (repoId: string): { x: number; y: number } => {
      const i = repoIds.indexOf(repoId);
      if (i === -1) return { x: this.width / 2, y: this.height / 2 }; // orbs: no repo pull
      const spread = Math.min(this.width, 900) * 0.36;
      const offset = repoIds.length > 1 ? (i - (repoIds.length - 1) / 2) * spread : 0;
      return { x: this.width / 2 + offset, y: this.height / 2 };
    };

    // Session orbs seed at the centroid of their footprint files, so a new
    // orb fades in amid its own territory instead of streaking across the map.
    const orbSeed = new Map<string, { x: number; y: number; n: number }>();
    for (const e of edges) {
      if (e.kind !== 'session') continue;
      const filePos = prev.get(e.target);
      if (!filePos) continue;
      const acc = orbSeed.get(e.source) ?? { x: 0, y: 0, n: 0 };
      acc.x += filePos.x ?? 0;
      acc.y += filePos.y ?? 0;
      acc.n += 1;
      orbSeed.set(e.source, acc);
    }

    const byId = new Map<string, SimNode>();
    this.simNodes = nodes.map((node) => {
      const t = normalizeHeat(node.heat);
      const a = normalizeHeat(node.runHeat ?? 0);
      const old = prev.get(node.id);
      const anchor = anchorFor(node.repoId);
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      const seed = orbSeed.get(node.id);
      const seedX = seed && seed.n > 0 ? seed.x / seed.n : (parent?.x ?? anchor.x);
      const seedY = seed && seed.n > 0 ? seed.y / seed.n : (parent?.y ?? anchor.y);
      const sn: SimNode = {
        id: node.id,
        node,
        t,
        a,
        radius: nodeRadius(node, glowOf(t, a)),
        x: old?.x ?? seedX + (Math.random() - 0.5) * 60,
        y: old?.y ?? seedY + (Math.random() - 0.5) * 60,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
      };
      byId.set(sn.id, sn);
      return sn;
    });
    this.simLinks = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e): SimLink => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, kind: e.kind }));

    // Which tables each table is joined to by a foreign key, either direction
    // — what a hover over a table keeps lit. Rebuilt only here, with the
    // links, never in the draw loop.
    this.foreignKeyKin = new Map();
    for (const link of this.simLinks) {
      if (link.kind !== 'fk') continue;
      const a = (link.source as SimNode).id;
      const b = (link.target as SimNode).id;
      if (!this.foreignKeyKin.has(a)) this.foreignKeyKin.set(a, new Set());
      if (!this.foreignKeyKin.has(b)) this.foreignKeyKin.set(b, new Set());
      this.foreignKeyKin.get(a)!.add(b);
      this.foreignKeyKin.get(b)!.add(a);
    }

    // Remember the shape we just laid out, so the next feed can be answered
    // without touching the sim. Built from what was HANDED IN, not from the
    // filtered simLinks — the next graph is compared against the same source,
    // and an edge dropped here for a missing endpoint would otherwise read as
    // a change forever.
    this.nodeIds = new Set(nodes.map((n) => n.id));
    this.edgeKeys = new Set(edges.map((e) => edgeKey(e.source, e.target)));

    this.refreshDerived(nodes);

    this.sim?.stop();
    this.sim = forceSimulation<SimNode>(this.simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(this.simLinks)
          .distance((l) => {
            if (l.kind === 'session') return 55;
            const s = l.source as SimNode;
            const t = l.target as SimNode;
            // The pond tile's mooring rope reaches PAST its own shore. The
            // ordinary 34-unit rest length is impossible against a ~130-unit
            // collision body: the spring pulls in, the collision throws back
            // out, forever — a strain that never settles, which is what made
            // the tile wander the map as if chasing the other dots. Rest the
            // rope just beyond the collision circle and the pair can actually
            // reach equilibrium and go still.
            if (isPondTile(s) || isPondTile(t)) return POND_TILE_COLLIDE_R + 24;
            // A foreign key rests with the two tables clear of each other;
            // a table's rope to its folder reaches past its own body, for
            // the same can't-ever-settle reason as the pond tile's.
            if (l.kind === 'fk') return s.radius + t.radius + 40;
            if (isTable(s) || isTable(t)) return Math.max(s.radius, t.radius) + 24;
            return s.node.kind === 'repo' ? 70 : 34;
          })
          // Session tethers are weak on purpose: the orb drifts to sit amid
          // its territory without dragging the tree out of shape. The tile's
          // mooring is nearly as slack — a body this size should be HELD near
          // the cards hub, not sprung to it.
          .strength((l) =>
            l.kind === 'session'
              ? 0.06
              : l.kind === 'fk'
                ? // A foreign key only LEANS related tables toward each
                  // other — enough that todos and its subtasks end up
                  // neighbours, never enough to fight the folder's rope.
                  0.04
                : isPondTile(l.source as SimNode) ||
                    isPondTile(l.target as SimNode) ||
                    isTable(l.source as SimNode) ||
                    isTable(l.target as SimNode)
                  ? 0.15
                  : 0.7,
          ),
      )
      .force(
        'charge',
        forceManyBody<SimNode>().strength((n) =>
          // A table pushes like a folder, not like a dot: it is a body with a
          // name to keep clear, and dot-strength charge packs them into soup.
          n.node.kind === 'file' && !isTable(n) ? -38 : n.node.kind === 'session' ? -70 : -140,
        ),
      )
      .force('collide', forceCollide<SimNode>((n) => n.radius + 4))
      .force('x', forceX<SimNode>((n) => anchorFor(n.node.repoId).x).strength((n) => (n.node.kind === 'session' ? 0 : 0.045)))
      .force('y', forceY<SimNode>((n) => anchorFor(n.node.repoId).y).strength((n) => (n.node.kind === 'session' ? 0 : 0.055)))
      .alpha(prev.size > 0 ? 0.35 : 1)
      .on('tick', () => {
        // Ballast. d3-force has no mass — every node coasts equally — so the
        // tile, the biggest body on the map, was being carried by every wave
        // that passed through the crowd. Bleeding most of its velocity each
        // tick makes it move like the heavy thing it is: nudges still land,
        // drift doesn't.
        // Tables get a lighter share of the same ballast: bigger than a
        // dot, smaller than the tile.
        for (const sn of this.simNodes) {
          const keep = isPondTile(sn) ? 0.3 : isTable(sn) ? 0.6 : 1;
          if (keep === 1) continue;
          sn.vx = (sn.vx ?? 0) * keep;
          sn.vy = (sn.vy ?? 0) * keep;
        }
        this.requestDraw();
      })
      // Quiescence = sleep. d3-force stops its own timer at alphaMin; one
      // final paint and nothing runs until the next setGraph.
      .on('end', () => this.requestDraw());
  }

  /** Running/pinging flags + focus rings, recomputed on every graph feed (both
   * the in-place and full-rebuild paths). */
  private refreshDerived(nodes: TerrainNode[]): void {
    this.hasRunning = nodes.some((n) => n.kind === 'session' && n.session?.running === true);
    this.refreshPinging(); // also calls updatePulseLoop
    // Node data was just rebuilt/updated — the focused session's writes/reads
    // may have moved (a live refetch, a lens breath), so re-derive its rings.
    // Same for whatever the cursor is resting on: a live poll landing mid-hover
    // must not freeze that agent's ring set at the shape it had a moment ago.
    this.recomputeFocusRings();
    this.recomputeHoverRings();
  }

  /** Center the whole graph in view (called once after first data lands). */
  fitSoon(): void {
    // Give the sim a few ticks to spread out before measuring.
    window.setTimeout(() => {
      if (this.destroyed || this.simNodes.length === 0) return;
      // A focused surface frames its agent's cluster instead — don't yank the
      // camera out to the whole graph once the orb exists to home in on.
      if (this.focusConv && this.computeFocusTransform()) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of this.simNodes) {
        minX = Math.min(minX, n.x ?? 0);
        maxX = Math.max(maxX, n.x ?? 0);
        minY = Math.min(minY, n.y ?? 0);
        maxY = Math.max(maxY, n.y ?? 0);
      }
      const w = Math.max(1, maxX - minX + 120);
      const h = Math.max(1, maxY - minY + 120);
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(this.width / w, this.height / h, 1.6)));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const t = zoomIdentity.translate(this.width / 2 - cx * k, this.height / 2 - cy * k).scale(k);
      select(this.canvas).call(this.zoomBehavior.transform, t);
    }, 600);
  }

  /** Nearest node within its hit radius of a client-space point, or null.
   * `sessionsOnly` narrows it to orbs: hover is aiming AT an agent, and on a
   * dense field a file half a pixel closer shouldn't steal the shot. */
  private nodeAt(ev: { clientX: number; clientY: number }, sessionsOnly = false): SimNode | null {
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.transform.invert([ev.clientX - rect.left, ev.clientY - rect.top]);
    const k = this.transform.k;
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of this.simNodes) {
      if (sessionsOnly && n.node.kind !== 'session') continue;
      if (this.hiddenFiles.has(n.id)) continue; // a hidden dot can't be tapped
      const dx = (n.x ?? 0) - wx;
      const dy = (n.y ?? 0) - wy;
      const dist = Math.hypot(dx, dy);
      // A table is hit by its RECTANGLE, plus a fingertip of slop — not by
      // its collision circle, which on a tall thin table is mostly empty
      // space either side of it and would steal taps meant for the map.
      if (n.node.file?.table) {
        const size = tableSize(n.node.file.table);
        const slop = TAP_RADIUS_PX / 2 / k;
        const inside =
          Math.abs(dx) <= size.width / 2 + slop && Math.abs(dy) <= size.height / 2 + slop;
        if (inside && dist < bestDist) {
          best = n;
          bestDist = dist;
        }
        continue;
      }
      // Generous, screen-space hit radius: the node's own drawn radius or a
      // fingertip's ~20px, whichever is bigger on screen.
      const hit = Math.max(n.radius, TAP_RADIUS_PX / k);
      if (dist <= hit && dist < bestDist) {
        best = n;
        bestDist = dist;
      }
    }
    return best;
  }

  private handleClick = (ev: MouseEvent): void => {
    this.onTap?.(this.nodeAt(ev)?.node ?? null);
  };

  /**
   * Hover: which agent is under the cursor. Mouse-only — a touch pointer fires
   * this too, and honouring it would leave a phone lit up for an agent she
   * merely tapped past, with no "move the cursor away" available to undo it.
   * Nothing here wakes the sim; a changed hover costs exactly one repaint.
   */
  private handlePointerMove = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'mouse') return;
    const hit = this.nodeAt(ev, true);
    const any = this.nodeAt(ev);
    // The cursor still turns into a pointer over any tappable node — files
    // open their sheet as well — even though only orbs drive the hover dim.
    this.canvas.style.cursor = hit || any?.node.kind === 'file' ? 'pointer' : '';
    this.setHoverAgent(hit?.node.session?.id ?? null);
    // A file under the cursor lights its own threads. An orb wins if both are
    // under it — the agent hover is the older, louder question.
    this.setHoverFile(hit === null && any?.node.kind === 'file' ? any.id : null);
    this.reportHover(hit);
  };

  private handlePointerLeave = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'mouse') return;
    this.canvas.style.cursor = '';
    this.setHoverAgent(null);
    this.setHoverFile(null);
    this.reportHover(null);
  };

  /**
   * Tell the page where the hovered orb is, if that answer has changed. Called
   * on every pointermove, so the guard matters: an unchanged report is dropped
   * here rather than turned into a React render, and a cursor parked on one orb
   * therefore costs nothing at all.
   */
  private reportHover(hit: SimNode | null, hard = false): void {
    const id = hit?.node.session?.id ?? null;
    if (id === null || hit === null) {
      if (this.hoverReport === null && !hard) return;
      this.hoverReport = null;
      this.onHoverAgent?.(null, hard);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const [sx, sy] = this.transform.apply([hit.x ?? 0, hit.y ?? 0]);
    const next: AgentHover = {
      id,
      x: rect.left + sx,
      y: rect.top + sy,
      r: hit.radius * this.transform.k,
    };
    const prev = this.hoverReport;
    // Sub-pixel drift (the sim still cooling under a still cursor) isn't news.
    if (prev && prev.id === id && Math.abs(prev.x - next.x) < 2 && Math.abs(prev.y - next.y) < 2) {
      return;
    }
    this.hoverReport = next;
    this.onHoverAgent?.(next);
  }

  /**
   * Which drawn nodes are the journal. The page passes ids because the rule
   * for what counts lives on the server (routes/pond.py JOURNAL_PATHS).
   */
  setPondNodes(ids: ReadonlySet<string> | null): void {
    this.pondIds = ids && ids.size > 0 ? ids : null;
    this.requestDraw();
  }

  /** Tint the water — on while she's looking at the landmark, off otherwise. */
  setPondLit(lit: boolean): void {
    if (this.pondLit === lit) return;
    this.pondLit = lit;
    this.requestDraw();
  }

  /**
   * The journal cluster's centre and reach, in WORLD units.
   *
   * A plain mean, undamped, and that's deliberate: this is the centroid of
   * something on the order of a thousand nodes, so the per-node jitter of a
   * cooling sim averages away to nothing and the anchor sits still without
   * any smoothing to keep alive. Damping it would need a rAF loop to finish
   * the easing, which is exactly the idle animation this engine promises
   * never to run.
   *
   * The reach is the RMS distance rather than the maximum, so one file flung
   * to the edge of the cluster by the force layout can't inflate the water to
   * swallow half the map.
   */
  private pondCentre(): { x: number; y: number; r: number } | null {
    if (!this.pondIds) return null;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let maxR = 0;
    for (const node of this.simNodes) {
      if (!this.pondIds.has(node.id)) continue;
      sx += node.x ?? 0;
      sy += node.y ?? 0;
      maxR = Math.max(maxR, node.radius);
      n += 1;
    }
    if (n === 0) return null;
    const cx = sx / n;
    const cy = sy / n;
    let sq = 0;
    for (const node of this.simNodes) {
      if (!this.pondIds.has(node.id)) continue;
      sq += ((node.x ?? 0) - cx) ** 2 + ((node.y ?? 0) - cy) ** 2;
    }
    // 1.5 RMS reaches past the bulk of a roughly gaussian blob without
    // chasing its outliers. The max member radius matters now that the pond
    // is mostly ONE body (the tile): a lone node has zero spread, and the
    // anchor should still say how much map the square is standing on.
    return { x: cx, y: cy, r: Math.max(1, Math.sqrt(sq / n) * 1.5, maxR) };
  }

  /**
   * The pond tile: a month of journal as a small square of water, drawn in
   * world space at the tile node's sim position.
   *
   * One column per day, oldest at the left, every day in the month drawn
   * whether or not she wrote in it. A column's HEIGHT is how many cards that
   * day holds, against the window's busiest day, with a floor so a one-card
   * day still shows above the water — the counts come from the journal itself
   * (pondNodes.ts / routes/terrain.py `_pond_days`), not from how many card
   * files this payload happened to carry. Its COLOUR is that
   * day's own heat on the map's live lens — which is what makes the tile
   * breathe on the backdrop: the exhale (one-day half-life) lights only the
   * newest columns, the inhale (one-month) warms the whole square. A quiet
   * day draws nothing and reads as bare water.
   *
   * The water body itself is the same blue family as the pondLit tint, kept
   * quiet — the tile is wallpaper on the backdrop and a map symbol on
   * /terrain; the DOM landmark carries anything textual.
   */
  private drawPondTile(n: SimNode, ramp: readonly string[], now: number): void {
    const { ctx, theme, transform } = this;
    const days = n.node.file?.days ?? [];
    if (days.length === 0) return;
    const heats = n.node.dayHeats ?? [];
    const side = Math.max(POND_TILE_SIDE, POND_TILE_MIN_PX / transform.k);
    const half = side / 2;
    const x0 = (n.x ?? 0) - half;
    const y0 = (n.y ?? 0) - half;

    // The water: a soft rounded square, filled and edged in the pond's blue.
    ctx.beginPath();
    ctx.roundRect(x0, y0, side, side, side * 0.09);
    ctx.fillStyle = theme.dark ? 'rgba(124,180,214,0.16)' : 'rgba(70,130,180,0.13)';
    ctx.fill();
    ctx.strokeStyle = theme.dark ? 'rgba(142,199,230,0.45)' : 'rgba(47,107,143,0.4)';
    ctx.lineWidth = 1 / transform.k;
    ctx.stroke();

    // The days, filling from the bottom like water.
    const pad = side * 0.08;
    const innerW = side - pad * 2;
    const innerH = side - pad * 2;
    const colW = innerW / days.length;
    let cMax = 1;
    for (const d of days) cMax = Math.max(cMax, d.touches.length);
    for (let i = 0; i < days.length; i += 1) {
      const count = days[i].touches.length;
      if (count === 0) continue;
      const h = innerH * (0.12 + 0.88 * (count / cMax));
      ctx.fillStyle = heatColor(normalizeHeat(heats[i] ?? 0), ramp);
      ctx.fillRect(x0 + pad + i * colW, y0 + pad + innerH - h, Math.max(colW * 0.78, 0.4), h);
    }

    // One-shot flash — a new card just landed in the pool. Same swell-and-fade
    // as a file dot's, ringed around the square's corners.
    const expiry = this.flashes.get(n.id);
    if (expiry !== undefined && expiry > now) {
      const p = 1 - (expiry - now) / 1000;
      const base = ctx.globalAlpha;
      ctx.globalAlpha = base * (1 - p) * 0.85;
      ctx.strokeStyle = ramp[ramp.length - 1];
      ctx.lineWidth = 2.5 / transform.k;
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, half * Math.SQRT2 + (3 + 10 * p) / transform.k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = base;
    }
  }

  /**
   * A database table, drawn as the table's own shape.
   *
   * One vertical stripe per column, so the WIDTH is the column count; the
   * HEIGHT under the header band is the row count on a square-root scale
   * (tableNodes.ts tableSize, which the tap card and the hit test share, so
   * picture, words and touch can't disagree). The band across the top stands
   * for the column names. Within it, a primary-key column is inked solid — the
   * column that identifies a row — and a foreign-key column is inked blue, the
   * same blue as the line that leaves the table for the one it points at. An
   * empty table is a dashed outline with only its header: structure, no rows.
   *
   * Opaque on purpose: foreign-key lines run centre to centre and are painted
   * first, so a solid body makes each line appear to stop at the table's edge.
   * Neutral ink, not heat — a table has no edit history on this map, and
   * wearing the ramp's cold black would claim it's an old file.
   */
  private drawTable(n: SimNode): void {
    const table = n.node.file?.table;
    if (!table) return;
    const { ctx, theme, transform } = this;
    const size = tableSize(table);
    const floor = TABLE_MIN_PX / transform.k;
    const width = Math.max(size.width, floor);
    const height = Math.max(size.height, floor);
    const x0 = (n.x ?? 0) - width / 2;
    const y0 = (n.y ?? 0) - height / 2;
    const columnWidth = width / Math.max(1, table.columns.length);
    const headerHeight = Math.min(HEADER_HEIGHT, height);
    const foreignColumns = new Set(table.foreign_keys.map((key) => key.column));

    // The body: opaque surface, then alternating column stripes over the rows.
    ctx.fillStyle = theme.bg;
    ctx.fillRect(x0, y0, width, height);
    for (let i = 0; i < table.columns.length; i += 1) {
      ctx.fillStyle = mixHex(theme.bg, theme.text, i % 2 === 0 ? 0.16 : 0.09);
      ctx.fillRect(x0 + i * columnWidth, y0 + headerHeight, columnWidth, height - headerHeight);
    }

    // The header band: one cell per column, inked by what the column is.
    for (let i = 0; i < table.columns.length; i += 1) {
      const column = table.columns[i];
      ctx.fillStyle = column.pk
        ? theme.text
        : foreignColumns.has(column.name)
          ? theme.evening
          : mixHex(theme.bg, theme.text, 0.42);
      // A hair of gap between cells so 22 columns read as 22, not as a bar.
      const gap = Math.min(columnWidth * 0.12, COLUMN_WIDTH * 0.12);
      ctx.fillRect(x0 + i * columnWidth + gap / 2, y0, columnWidth - gap, headerHeight);
    }

    // The outline — dashed when the table holds no rows at all.
    ctx.strokeStyle = mixHex(theme.bg, theme.text, 0.55);
    ctx.lineWidth = 1 / transform.k;
    if (table.rows === 0) ctx.setLineDash([3 / transform.k, 3 / transform.k]);
    ctx.strokeRect(x0, y0, width, height);
    ctx.setLineDash([]);
  }

  /** Tell the page where the water is, if that answer has moved. */
  private reportPond(): void {
    const centre = this.pondCentre();
    if (!centre) {
      if (this.pondReport === null) return;
      this.pondReport = null;
      this.onPondMove?.(null);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const [sx, sy] = this.transform.apply([centre.x, centre.y]);
    const next: PondAnchor = {
      x: rect.left + sx,
      y: rect.top + sy,
      r: centre.r * this.transform.k,
    };
    const prev = this.pondReport;
    if (prev && Math.abs(prev.x - next.x) < 1 && Math.abs(prev.y - next.y) < 1
        && Math.abs(prev.r - next.r) < 1) {
      return;
    }
    this.pondReport = next;
    this.onPondMove?.(next);
  }

  /**
   * Pin the hover lighting to one agent (or release it with null). /terrain
   * holds it for exactly as long as that agent's hovercard is on screen: the
   * card sits off the canvas, so travelling into it takes the cursor off the
   * orb, and without the pin the map would un-dim the moment she set off
   * towards the thing she's reading. Pointing at a DIFFERENT orb still wins —
   * a real hover outranks the pin, and the page re-pins to the new one.
   */
  holdHover(id: string | null): void {
    this.heldHover = id;
    this.setHoverAgent(id);
  }

  /** Null means "the cursor is on nothing" — which only actually clears the
   * lighting when no card is holding it open (see holdHover). */
  private setHoverAgent(id: string | null): void {
    const next = id ?? this.heldHover;
    if (this.hoverAgent === next) return;
    this.hoverAgent = next;
    this.recomputeHoverRings();
    this.requestDraw();
  }

  private recomputeHoverRings(): void {
    this.hoverRings = this.hoverAgent
      ? sessionTouchRings(this.simNodes.map((sn) => sn.node), this.hoverAgent)
      : new Map();
  }

  /** The hover that's actually in effect. A committed tap-spotlight outranks
   * it: that gesture has already dimmed the map to one agent, and a second
   * dimming rule layered over it would only fight the first. */
  private activeHover(): string | null {
    return this.footprint === null ? this.hoverAgent : null;
  }

  private requestDraw(): void {
    if (this.drawQueued || this.destroyed) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (!this.destroyed) this.draw();
    });
  }

  private draw(): void {
    // Focus camera eases first so this paint uses the stepped transform; it
    // self-requests the next frame until it settles on the agent's cluster.
    if (this.focusConv) this.stepFocusCamera();
    const { ctx, theme, transform } = this;
    const dpr = window.devicePixelRatio || 1;
    const { ember: ramp, gold: goldRamp } = heatRamps(theme);
    const dimmed = this.footprint !== null;
    // The agent under the cursor, if the tap-spotlight isn't already speaking.
    // Everything it changes is an ALPHA: the other agents' tethers and rings
    // recede, nothing about the terrain itself moves or re-colours.
    const hover = this.activeHover();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const now = Date.now();
    // Breathing pulse phase for running orbs — ~2s period, gentle.
    const breathe = 1 + 0.16 * Math.sin((now % 2000) / 2000 * Math.PI * 2);

    // -- the pond's water --
    // Under everything, because it is GROUND, not a mark: the journal files
    // sit IN it. Drawn only while the landmark is being looked at — at rest
    // the map says nothing about it, and approaching the little pond is what
    // shows you which part of the terrain it's the thumbnail OF.
    const pond = this.pondCentre();
    if (pond && this.pondLit) {
      const grad = ctx.createRadialGradient(pond.x, pond.y, 0, pond.x, pond.y, pond.r);
      grad.addColorStop(0, this.theme.dark ? 'rgba(124,180,214,0.20)' : 'rgba(70,130,180,0.16)');
      grad.addColorStop(1, 'rgba(70,130,180,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pond.x, pond.y, pond.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // -- threads: what one file makes, another one eats --
    //
    // Drawn UNDER the tree edges and the dots, because a thread is a current
    // running beneath the structure rather than part of it. Gold, on the same
    // ramp the run channel wears, because a thread is a write that running
    // code just made — the exact thing gold means everywhere else on this map.
    //
    // Bowed, not straight. Two files often sit near each other and several
    // threads can share a pair of endpoints' neighbourhood; a straight line
    // between close dots disappears under them, and parallel straight lines
    // between the same region stack into one thick smear. A consistent
    // perpendicular bow gives each its own arc and makes the direction of the
    // current legible.
    //
    // Nothing here is capped or culled by count: cold threads simply arrive
    // with t near zero and draw at an alpha that rounds to nothing. The heat IS
    // the filter, so what's on screen is what's actually moving.
    if (this.threads.length > 0) {
      const byId = new Map(this.simNodes.map((n) => [n.id, n]));
      const held = this.hoverFile;
      for (const th of this.threads) {
        const mine = held !== null && (th.sourceId === held || th.targetId === held);
        // Off-hover a cold thread is skipped as invisible. ON hover the
        // hovered file's own threads are drawn however cold they are: the
        // question being asked is "what is this wired to", and a pipe that
        // hasn't moved in a month is still a pipe. Cold ones stay legibly
        // cold — the floor below lifts them into view, it doesn't repaint
        // them as fresh.
        if (!mine && th.t <= 0.02) continue;
        if (held !== null && !mine && th.t <= 0.25) continue;
        const a = byId.get(th.sourceId);
        const b = byId.get(th.targetId);
        if (!a || !b) continue; // one end filtered off the map by a dial
        if (this.hiddenFiles.has(a.id) || this.hiddenFiles.has(b.id)) continue; // or hidden by the activity switch
        const ax = a.x ?? 0;
        const ay = a.y ?? 0;
        const bx = b.x ?? 0;
        const by = b.y ?? 0;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        // Bow perpendicular to the run, proportional to it, so long threads
        // arc gently and short ones don't loop absurdly.
        const bow = Math.min(len * 0.16, 60);
        // Hovering a file is asking one question, so the answer gets the
        // canvas: its own threads go to full opacity with a colour floor that
        // guarantees a cold one is actually visible, and every other thread
        // drops to a trace. Same shape as the agent hover one rung along —
        // the map recedes around what she pointed at rather than clearing.
        const lit = held === null ? th.t : mine ? Math.max(th.t, 0.42) : th.t;
        ctx.globalAlpha = held === null ? 0.16 + 0.54 * th.t : mine ? 0.95 : 0.05;
        ctx.strokeStyle = heatColor(lit, goldRamp);
        ctx.lineWidth = (0.6 + 1.5 * lit) / transform.k * (mine ? 1.6 : 1);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(mx - (dy / len) * bow, my + (dx / len) * bow, bx, by);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // -- edges --
    ctx.lineWidth = 1 / transform.k;
    for (const link of this.simLinks) {
      const s = link.source as SimNode;
      const t = link.target as SimNode;
      // A line to a hidden dot would end in empty space, so it goes too —
      // the tree edge from its folder and any agent's tether alike.
      if (this.hiddenFiles.has(s.id) || this.hiddenFiles.has(t.id)) continue;
      const inPrint = !dimmed || this.footprint!.has(s.id) || this.footprint!.has(t.id);
      if (link.kind === 'session') {
        // Orb tethers: identity-accent threads, dashed so they never read as
        // tree structure. The dashes carry a little more weight than the tree
        // edges do — which agent is holding which files is the thing she's
        // reading the map FOR, and at the old alpha the thread thinned out to
        // nothing against a busy field. The accent colour itself is untouched
        // (her call: "i like the purple they are now, but the dotted lines
        // could be slightly stronger") — only presence changed, not hue.
        //
        // Under a hover, the tethers sort into two: the hovered agent's own
        // threads brighten a step, and every other agent's drop most of the
        // way out. Which end of the link is the orb isn't assumed — the graph
        // builds session edges orb→file, but reading it off the node kind
        // means a flipped edge dims the right agent rather than nobody.
        const orbEnd = s.node.kind === 'session' ? s : t.node.kind === 'session' ? t : null;
        const sid = orbEnd?.node.session?.id;
        ctx.globalAlpha =
          hover !== null ? (sid === hover ? 0.62 : 0.06) : inPrint ? 0.45 : 0.13;
        ctx.strokeStyle = this.orbStroke;
        ctx.lineWidth = 1.3 / transform.k;
        ctx.setLineDash([4 / transform.k, 5 / transform.k]);
      } else if (link.kind === 'fk') {
        // Foreign keys: solid lines in the app's blue, a step heavier than
        // the tree — "these two tables are joined" is a different statement
        // from "this file is in that folder", so it gets its own ink. Blue
        // because red and gold are heat and the accent is the agents'. Under
        // a table hover the hovered table's own keys thicken and skip the
        // fade just below, while the rest recede with the tree.
        ctx.globalAlpha = inPrint ? 0.7 : 0.15;
        ctx.strokeStyle = theme.evening;
        ctx.lineWidth = (s.id === this.hoverFile || t.id === this.hoverFile ? 2.2 : 1.4) / transform.k;
        ctx.setLineDash([]);
      } else {
        ctx.globalAlpha = inPrint ? 0.55 : 0.15;
        ctx.strokeStyle = theme.border;
        ctx.lineWidth = 1 / transform.k;
        ctx.setLineDash([]);
      }
      // The structure recedes under a file hover as well. Without this the
      // tree stays at full strength while the dots fall away, and the map
      // reads as a skeleton with the flesh removed rather than as one thing
      // stepping back.
      const hoveredKey =
        link.kind === 'fk' && (s.id === this.hoverFile || t.id === this.hoverFile);
      if (this.hoverFile !== null && !hoveredKey) ctx.globalAlpha *= 0.22;
      ctx.beginPath();
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // -- nodes --
    const minR = MIN_NODE_PX / transform.k;   // world units for a screen-px floor
    const threadHover = this.hoverFile;
    for (const n of this.simNodes) {
      // Hidden by the All / Recent / Old switch: skipped whole, so its rings,
      // write core and flash go with it.
      if (this.hiddenFiles.has(n.id)) continue;
      const inPrint = !dimmed || this.footprint!.has(n.id);
      // A file hover pulls the whole map down around the thread it lit: the
      // hovered dot and everything wired to it stay full, everything else
      // recedes. Multiplied into the footprint alpha rather than replacing it,
      // so a spotlit agent's dimming still holds underneath.
      const kinAlpha = threadHover === null || this.hoverFileKin.has(n.id) ? 1 : 0.15;
      ctx.globalAlpha = (inPrint ? 1 : 0.22) * kinAlpha;
      // Never let a node shrink below a visible dot, however far out we are.
      const nr = Math.max(n.radius, minR);
      // Set by a branch that paints its own body (the dark ash+hue file dot),
      // so the one generic fill further down knows to stand aside.
      let bodyDrawn = false;

      if (n.node.kind === 'session') {
        // Session orb: a stroked ring in the identity accent — never a
        // filled ember disc, so sessions can't be confused with heat.
        //
        // Three states, and they are the session roster's own, spoken as a
        // circle: RUNNING gently undulates (a turn is in flight); WAITING —
        // finished, with activity newer than the last time she opened it —
        // holds still and sends an orange sonar ping outward, in the same
        // --orange the session list raises its hand with; anything else is
        // simply two still purple rings. The orb body never changes colour,
        // so waiting is a *motion*, not a repaint. Running beats waiting,
        // because an agent mid-turn isn't asking for her yet.
        const sessionId = n.node.session?.id;
        const running = n.node.session?.running === true;
        const pinging = !running && sessionId !== undefined && this.pingAgents.has(sessionId);
        const r = running ? nr * breathe : nr;
        // In focus mode (backdrop) the agent she's actually viewing burns full
        // purple; every other active agent is dimmed so the running one it's
        // standing behind reads as THE one (her 07-27 call). Off focus
        // (/terrain) orbs keep the objective in/out-of-print alpha.
        const isFocusOrb =
          this.focusConv !== null && n.id === `${SESSION_NODE_PREFIX}${this.focusConv}`;
        // Hover does the same thing one rung softer than focus does: the orb
        // under the cursor burns full, its neighbours recede far enough to
        // read as context but not so far as to vanish — she's pointing at one
        // agent, not asking the others to leave the map.
        const orbAlpha =
          this.focusConv !== null
            ? isFocusOrb
              ? 1
              : 0.38
            : hover !== null
              ? sessionId === hover
                ? 1
                : 0.26
              : inPrint
                ? 1
                : 0.22;
        // An orb is a dot too, as far as "everything else dims" goes.
        const orbKinAlpha = orbAlpha * kinAlpha;

        // Sonar. Two of them, same ring, different things to say — and, more
        // to the point, different clocks:
        //
        //   ORANGE — this agent is waiting on her (/terrain). Free-running on
        //     its own ~2.6s period, staggered per agent so several waiting
        //     orbs read as separate hands going up rather than one strobe.
        //     /terrain has no breath for it to ride.
        //   PURPLE — the agent whose conversation she's reading, on the
        //     backdrop. Fired by the BREATH, at both of its turns (see
        //     pulseFocusSonar) — so the agent and the terrain are one organism
        //     keeping one rhythm, instead of two animations beating against
        //     each other. Two rings a cycle, 4s and 6s apart, uneven because
        //     the breath is.
        //
        // Purple joins the running orb's undulation rather than replacing it:
        // the breath says "working", the sonar says "working for you, here".
        //
        // Either goes down FIRST so the orb's own rings paint over its inner
        // edge — the ring reads as leaving the body rather than crossing it.
        if (pinging) {
          const p = (((now / PING_PERIOD_MS + stringPhase(sessionId!)) % 1) + 1) % 1;
          this.strokeSonar(n.x ?? 0, n.y ?? 0, r, theme.orange, p, orbAlpha);
        } else if (isFocusOrb && this.focusSonarAt > 0) {
          const age = now - this.focusSonarAt;
          if (age >= 0 && age < FOCUS_SONAR_MS) {
            this.strokeSonar(n.x ?? 0, n.y ?? 0, r, this.orbStroke, age / FOCUS_SONAR_MS, orbAlpha);
          }
        }

        ctx.globalAlpha = orbKinAlpha;
        ctx.strokeStyle = this.orbStroke;
        ctx.lineWidth = (isFocusOrb || sessionId === hover ? 3.25 : 2.5) / transform.k;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2);
        ctx.stroke();
        // Halo: a second, fainter ring — the "orb" read.
        ctx.globalAlpha = orbKinAlpha * (running ? 0.45 : 0.25);
        ctx.lineWidth = 1.5 / transform.k;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, r + 4 / transform.k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = inPrint ? 1 : 0.22;
        continue;
      }

      if (n.node.kind === 'file' && n.node.file?.days) {
        // The pond tile — the journal's one body on the map. Drawn as a
        // square of water rather than a dot, and never labeled by the engine.
        this.drawPondTile(n, ramp, now);
        continue;
      }

      if (n.node.kind === 'file' && n.node.file?.table) {
        // A database table — drawn as its own shape, columns wide and rows
        // tall, rather than as a dot.
        this.drawTable(n);
        continue;
      }

      if (n.node.kind === 'file') {
        // Freshly created (within 24h, any agent) — git-add green. The
        // loudest thing a file can be is new, so it beats heat on both
        // surfaces. Only the "Types" toggle, just below, overrides it.
        const fresh = n.node.file
          ? fileCreatedWithin(n.node.file, CREATED_FRESH_WINDOW_SECONDS, now / 1000)
          : false;
        if (this.typeColors) {
          // The "Types" toggle overrides every other fill. The dot wears its
          // file type's GitHub colour flat — not green for new, not red or
          // gold for heat — on both surfaces. Heat still sets the dot's SIZE
          // (nodeRadius), so a busy file is a big dot of its type's colour.
          // Prompt: "a toggle that overrides the other colors when i toggle
          // it on".
          const path = n.node.path ?? n.node.label;
          let typeColor = this.typeColorCache.get(path);
          if (typeColor === undefined) {
            typeColor = typeDotColor(fileTypeOf(path).color, theme.bg, theme.text);
            this.typeColorCache.set(path, typeColor);
          }
          ctx.fillStyle = typeColor;
        } else if (fresh) {
          ctx.fillStyle = CREATED_GREEN;
        } else if (theme.dark) {
          // Dark: an opaque ASH disc, then the LEAN hue over it at GLOW
          // opacity (vocabulary in the ramp block up top). Both fires share
          // the floor, and a file with both kinds of life turns between them
          // under the breath instead of one hiding the other. Painted here,
          // so the generic fill below is skipped; rings and halos still draw.
          const glow = glowOf(n.t, n.a);
          ctx.fillStyle = theme.ash;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, nr, 0, Math.PI * 2);
          ctx.fill();
          if (glow > 0) {
            const base = ctx.globalAlpha;
            ctx.globalAlpha = base * glowAlpha(glow);
            ctx.fillStyle = mixHex(EMBER_HOT, GOLD_HOT, leanOf(n.t, n.a));
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, nr, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = base;
          }
          bodyDrawn = true;
        } else {
          // Light (untouched, her call to tune dark first): the old priority
          // rule — anything that ran paints the gold ramp and hides the red
          // history, else the red heat ramp.
          ctx.fillStyle = n.a > 0 ? heatColor(n.a, goldRamp) : heatColor(n.t, ramp);
        }
      } else {
        // Hubs: structural, mostly surface-toned (bg pushed toward ink),
        // warmed by rolled-up heat so a hot subtree's spine reads warm too.
        // --text is hex in every sky phase; --text-muted may be rgba, so mix
        // from text.
        ctx.fillStyle = mixHex(mixHex(theme.bg, theme.text, 0.22), heatColor(n.t, ramp), 0.5 * n.t);
      }
      if (!bodyDrawn) {
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, nr, 0, Math.PI * 2);
        ctx.fill();
      }
      if (n.node.kind === 'file') this.drawWriteCore(n, nr, now);
      if (n.node.kind !== 'file') {
        ctx.strokeStyle = theme.border;
        ctx.lineWidth = 1.5 / transform.k;
        ctx.stroke();
      }
      // How this file was touched, when anything on screen touched it: the
      // backdrop's focused conversation first, else /terrain's shown-agent
      // set. Reads get a white ring; created and modified files both take the
      // agent's purple (her 07-27 call: created-ness is the green DOT above,
      // so the ring only ever says "an agent on this map touched it").
      // Full-alpha on an undimmed map; under a spotlight (a search, or a
      // tapped agent) a ring on a file outside the lit set recedes with its
      // dot, so the rings can't keep shouting over a map that's gone quiet.
      // Prompt: "make it such that all the circles surrounding things that
      // agents are touching also dim".
      let ring =
        n.node.kind === 'file' ? (this.focusRings.get(n.id) ?? this.agentRings.get(n.id)) : undefined;
      // Under a hover the rings answer a narrower question. A file the hovered
      // agent touched wears ITS relationship — purple where this agent wrote,
      // white where it only read, even if a louder agent also wrote the file
      // and was winning the ring a moment ago. Every other ring on the map
      // fades to a trace: still there, no longer competing.
      let ringAlpha = 1;
      if (hover !== null && n.node.kind === 'file') {
        const own = this.hoverRings.get(n.id);
        if (own) ring = own;
        else if (ring) ringAlpha = 0.1;
      }
      // Footprint ring — the spotlit session's files, in plain ink. Skipped
      // wherever a touch ring is about to land: that ring says everything
      // this one does and more (purple = written, white = read), so drawing
      // both would bury the distinction under a second, flatter circle.
      if (dimmed && !ring && this.footprint!.has(n.id)) {
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 2 / transform.k;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, nr + 3.5 / transform.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (ring) {
        ctx.globalAlpha = ringAlpha * (inPrint ? 1 : 0.22);
        ctx.strokeStyle = ring === 'read' ? READ_RING : this.orbStroke;
        ctx.lineWidth = 2.4 / transform.k;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, nr + 4 / transform.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      // One-shot flash: a hot-end halo swelling and fading over ~1s (live
      // mode's "that file just got touched").
      const expiry = this.flashes.get(n.id);
      if (expiry !== undefined && expiry > now) {
        const p = 1 - (expiry - now) / 1000; // 0 → 1 over the second
        ctx.globalAlpha = (1 - p) * 0.85;
        ctx.strokeStyle = ramp[ramp.length - 1];
        ctx.lineWidth = 2.5 / transform.k;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, nr + (3 + 10 * p) / transform.k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.globalAlpha = 1;

    // -- code-weather: written lines rising off their file nodes --
    //
    // Ambient by design: 12px screen-locked mono (the app's floor — it may be
    // atmosphere but it's still text), the theme's secondary ink, never
    // brighter than ~0.6. Quick fade-in, a decelerating rise (real things
    // slow as they dissipate), a slow sinusoidal wander so parallel lines
    // read as drift rather than a formation, and a fade-out over the back
    // half. Position is world (it belongs to its node); size is screen.
    if (this.weatherFrags.length > 0) {
      const nodePos = new Map<string, SimNode>();
      for (const n of this.simNodes) if (!this.hiddenFiles.has(n.id)) nodePos.set(n.id, n);
      ctx.font = `${WEATHER_PX / transform.k}px ${WEATHER_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = theme.textSecondary;
      for (const f of this.weatherFrags) {
        const age = now - f.born;
        if (age < 0 || age >= WEATHER_LIFE_MS) continue; // staggered: not yet born
        const n = nodePos.get(f.nodeId);
        if (!n) continue;
        const p = age / WEATHER_LIFE_MS;
        const easeOut = 1 - (1 - p) * (1 - p);
        const fadeIn = Math.min(p / 0.1, 1);
        const fadeOut = p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
        ctx.globalAlpha = fadeIn * fadeOut * 0.6;
        const rise = (easeOut * WEATHER_RISE_PX) / transform.k;
        const wander = (Math.sin(f.seed + p * 4) * 5) / transform.k;
        ctx.fillText(
          f.text,
          (n.x ?? 0) + wander,
          (n.y ?? 0) - Math.max(n.radius, minR) - 4 / transform.k - rise,
        );
      }
      ctx.globalAlpha = 1;
    }

    // -- labels (screen space — never below the 12px floor at any zoom) --
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const k = transform.k;
    // Wallpaper doesn't caption itself — unless the step-back view has asked
    // it to, which is the one moment the backdrop is being looked at rather
    // than read over.
    const captioned = this.ambient && this.ambientLabels;
    if (this.ambient && !captioned) return;
    // Which files get named, when an agent is spotlit. Above readable zoom
    // there's room for its whole footprint; below it only the head of the
    // recency list, so pulling back thins the captions to the newest work
    // instead of stacking them into soup. Nothing spotlit → no file labels at
    // all: the eight-hottest labels this replaced looked arbitrary precisely
    // because no gesture had asked for them.
    //
    // The step-back view asks the same question of a different set: there is
    // no tap-spotlight behind a conversation, so the named files are the ones
    // the FOCUSED agent has touched — the same set already wearing rings. Same
    // zoom rule, same cap, so a dense map can't turn into soup here either.
    const ambientNamed =
      this.focusRings.size === 0
        ? null
        : k >= LABEL_MIN_K
          ? new Set(this.focusRings.keys())
          : new Set([...this.focusRings.keys()].slice(0, FOOTPRINT_LABEL_CAP));
    const namedFiles = captioned
      ? ambientNamed
      : this.footprintLabels.length === 0
        ? null
        : k >= LABEL_MIN_K
          ? this.footprintLabelSet
          : new Set(this.footprintLabels.slice(0, FOOTPRINT_LABEL_CAP));
    for (const n of this.simNodes) {
      if (this.hiddenFiles.has(n.id)) continue; // no caption for a dot that isn't drawn
      if (n.node.file?.table) continue; // tables are named in their own pass, below
      if (n.node.kind === 'file' && !(namedFiles !== null && namedFiles.has(n.id))) continue;
      // Directories caption themselves at readable zoom on the map proper. In
      // the step-back view zoom is not hers to set, so the bound is relevance
      // instead: only the directories the focused agent is actually working
      // inside get named, however far out the camera happens to be sitting.
      if (n.node.kind === 'dir' && (captioned ? !this.focusDirIds.has(n.id) : k < LABEL_MIN_K)) continue;
      // Orbs wear their titles by default — an agent's name is its identity,
      // not something to uncover — but the caller can narrow it. /terrain
      // passes the agents active within the hour, because a twelve-agent pool
      // labeled in full is a wall of text. (Files are the opposite: named only
      // on demand, see namedFiles above.) A spotlight still quiets the rest,
      // via the in-footprint test on the next line.
      // The one exception is the orb under the cursor: pointing at an agent is
      // itself the question "who is this", so it says its name even when it's
      // outside the labeled set (an older agent under the Open pool, say).
      const hovered = n.node.kind === 'session' && n.node.session?.id === hover;
      if (n.node.kind === 'session' && this.labeledAgents !== null && !hovered) {
        const sid = n.node.session?.id;
        if (sid === undefined || !this.labeledAgents.has(sid)) continue;
      }
      const inPrint = !dimmed || this.footprint!.has(n.id);
      if (n.node.kind !== 'repo' && dimmed && !inPrint) continue;
      const sx = (n.x ?? 0) * k + transform.x;
      const sy = (n.y ?? 0) * k + transform.y;
      if (sx < -80 || sx > this.width + 80 || sy < -40 || sy > this.height + 40) continue;
      // Names follow their orbs into the background: with a hover up, the
      // other agents' titles recede alongside their rings rather than sitting
      // there at full weight over a map that's stopped talking about them.
      ctx.globalAlpha = hover !== null && n.node.kind === 'session' && !hovered ? 0.3 : 1;
      if (n.node.kind === 'repo') {
        ctx.font = `700 ${LABEL_PX + 2}px ${this.fontFamily}`;
        ctx.fillStyle = theme.text;
        ctx.fillText(n.node.label, sx, sy - n.radius * k - 5);
      } else if (n.node.kind === 'dir') {
        ctx.font = `600 ${LABEL_PX}px ${this.fontFamily}`;
        ctx.fillStyle = theme.textSecondary;
        ctx.fillText(n.node.label, sx, sy - n.radius * k - 4);
      } else if (n.node.kind === 'session') {
        // Orb titles in ink (identity color stays on the ring itself).
        ctx.font = `600 ${LABEL_PX}px ${this.fontFamily}`;
        ctx.fillStyle = theme.text;
        ctx.fillText(truncateLabel(n.node.label), sx, sy - n.radius * k - 8);
      } else {
        // A spotlit agent's files: filename only, a step quieter than the
        // orb's own title above them, so the agent still reads as the subject
        // and its files as the answer.
        ctx.font = `600 ${LABEL_PX}px ${this.fontFamily}`;
        ctx.fillStyle = theme.textSecondary;
        ctx.fillText(n.node.label, sx, sy - n.radius * k - 4);
      }
    }

    this.drawTableLabels(dimmed);

    // Last, so the anchor it reports is the one this frame actually drew.
    this.reportPond();
  }

  /**
   * Name the tables, without letting the names pile up — this is greedy label
   * placement, the way a map decides which towns to name at each zoom.
   *
   * Tables sit close together and their names are wider than they are, so
   * naming all of them at once is a smear of text. Instead the candidates are
   * taken in order of importance — the hovered table and the tables it's
   * joined to first, then biggest first — and a name is only drawn if its box
   * doesn't overlap one already drawn. Zoom in and the tables spread apart on
   * screen, so more names fit; nothing is ever hidden for good.
   *
   * The name sits above the rectangle. At readable zoom a second line under
   * it gives the size in words — "2,773 × 13", rows × columns — the fact the
   * rectangle is a picture of. Screen space, so never under the 12px floor.
   */
  private drawTableLabels(dimmed: boolean): void {
    const { ctx, theme, transform } = this;
    const k = transform.k;
    if (k < TABLE_LABEL_MIN_K) return;
    const detailed = k >= LABEL_MIN_K;
    const kin = this.hoverFile !== null ? this.hoverFileKin : null;

    const candidates = this.simNodes.filter(
      (n) =>
        n.node.file?.table !== undefined &&
        !this.hiddenFiles.has(n.id) &&
        !(dimmed && !this.footprint!.has(n.id)),
    );
    candidates.sort((a, b) => {
      const kinFirst = Number(kin?.has(b.id) ?? false) - Number(kin?.has(a.id) ?? false);
      return kinFirst || b.node.file!.table!.rows - a.node.file!.table!.rows;
    });

    const placed: { left: number; right: number; top: number; bottom: number }[] = [];
    const lineHeight = LABEL_PX + 2;
    for (const n of candidates) {
      const table = n.node.file!.table!;
      const x = (n.x ?? 0) * k + transform.x;
      const bottom = ((n.y ?? 0) - tableSize(table).height / 2) * k + transform.y - 4;
      if (x < -80 || x > this.width + 80 || bottom < -40 || bottom > this.height + 40) continue;

      ctx.font = `600 ${LABEL_PX}px ${this.fontFamily}`;
      const halfWidth = ctx.measureText(table.name).width / 2 + 4;
      const box = {
        left: x - halfWidth,
        right: x + halfWidth,
        top: bottom - lineHeight * (detailed ? 2 : 1),
        bottom,
      };
      const collides = placed.some(
        (p) => box.left < p.right && box.right > p.left && box.top < p.bottom && box.bottom > p.top,
      );
      if (collides) continue;
      placed.push(box);

      // With a table hovered, the names outside its joins step back with
      // their rectangles.
      ctx.globalAlpha = kin === null || kin.has(n.id) ? 1 : 0.3;
      if (detailed) {
        ctx.font = `500 ${LABEL_PX}px ${this.fontFamily}`;
        ctx.fillStyle = theme.textMuted;
        ctx.fillText(`${table.rows.toLocaleString()} × ${table.columns.length}`, x, bottom);
        ctx.font = `600 ${LABEL_PX}px ${this.fontFamily}`;
      }
      ctx.fillStyle = theme.text;
      ctx.fillText(table.name, x, bottom - (detailed ? lineHeight : 0));
    }
    ctx.globalAlpha = 1;
  }
}

/** Reads the live theme tokens off documentElement — the sky engine applies
 * palettes as inline custom properties, so this is always current. Dark is
 * judged from the effective --bg luminance (same test usageHeat.ts uses). */
export function readThemeInk(): ThemeInk {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const bg = get('--bg', '#f5f0e8');
  let dark = false;
  if (/^#[0-9a-fA-F]{6}$/.test(bg)) {
    const [r, g, b] = hexToRgbTuple(bg);
    dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  }
  const text = get('--text', dark ? '#ddd0e8' : '#1a1815');
  // Ash: the page lifted ASH_LIFT toward ink for its BRIGHTNESS, then
  // flattened to a neutral grey of that luminance so none of the page's hue
  // survives in it. Needs two hex colours; --text is hex in every sky phase
  // and --bg is hex whenever `dark` could be judged. Otherwise a grey that
  // sits right on the twilight palette.
  const hex = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);
  let ash = '#313131';
  if (hex(bg) && hex(text)) {
    const [r, g, b] = hexToRgbTuple(mixHex(bg, text, ASH_LIFT));
    const grey = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    ash = mixHex('#000000', '#ffffff', grey / 255);
  }
  return {
    bg,
    text,
    textSecondary: get('--text-secondary', dark ? 'rgba(200,185,220,0.75)' : '#2a2522'),
    textMuted: get('--text-muted', dark ? 'rgba(170,155,190,0.5)' : 'rgba(30,25,20,0.6)'),
    border: get('--border', dark ? '#2e2545' : '#888391'),
    accent: get('--accent', '#7c5cbf'),
    evening: get('--evening', '#6a7acc'),
    orange: get('--orange', '#d4700a'),
    ash,
    dark,
  };
}
