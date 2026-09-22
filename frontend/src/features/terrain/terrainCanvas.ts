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
 * The map is HERS to arrange, and it stays arranged. Positions, the nodes she
 * dragged, and the camera are written to layoutMemory.ts as this engine is
 * destroyed and read back by the next one, so leaving the page and returning
 * reopens the map she left instead of laying out a new one — opt-in, with
 * `remember: true`, which only the real map asks for. Dragging a node pins it
 * where she dropped it (d3's fx/fy) until she releases it or reloads the page;
 * a press that starts on a draggable node is a drag, and the zoom behaviour
 * stands down for it (see the filter in the constructor).
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
 * 'fk' link kind). They are the one thing the physics doesn't place: they
 * stand pinned on shelves in a section of their own in the corridor BETWEEN
 * the two repos (`placeShelves`), one family of joined tables per shelf on a
 * shared baseline, with the foreign keys running under the shelf. That
 * corridor is made, not found — the repos are anchored far enough apart to
 * leave room for the section, and the 'shelfKeepOut' force pushes any dot
 * that drifts in back out through the side facing its own repo. Unlike the tile
 * they name themselves, because a rectangle with no name teaches nothing.
 * Hovering one keeps the tables it's joined to lit; CLICKING one pins that
 * lighting on (`holdFileHover`) so it can be read without holding the mouse
 * still, and reports the tap through `onTap` like any file — the page makes
 * the second click on the same table the one that opens its card.
 *
 * Every file dot NAMES ITSELF under the cursor (`hoverLabel`), on a plate of
 * the map's background so the name is readable over a dense field — pointing
 * at something is the gesture that asks "what is this". It also says WHERE IT
 * IS KEPT: the hover dims the whole map to `UNSELECTED_FADE` except that dot,
 * anything wired to it, and the chain of folders it sits inside (`kinOf` +
 * homeChain, in hoverSelection.ts), so the bright boxes around it are its
 * address — named at any zoom, with the tree lines between them drawn in the
 * dot's own colour (`fileDotInk`), so the path up to where it lives can be
 * followed by eye. That colour stops short of GOLD and is floored off the
 * bottom (`hoverLayers.ts`): gold is already what the data threads are drawn
 * in, so a chain that reached it read as a thread rather than as an address,
 * and a stale dot's chain was faintest for exactly the file whose home is
 * hardest to find.
 * Wired to it includes the AGENTS holding it and the TABLES it touches, which
 * keep their colour and their line while the cursor is on one of their files.
 *
 * Once a body is PICKED OUT — a spotlit agent, a search (both arrive as
 * `footprint`), or a pinned table (`heldFile`) — everything outside it is
 * SCENERY: it takes no gesture at all (`isTouchable`, asked by `nodeAt`), so
 * an unselected dot can't be hovered, dragged, pinned or opened, and a click
 * on one reads as a click on empty canvas and gives the map back. A selection
 * lights the folders its members are kept in as well as the members
 * themselves (`footprintLit`), so a spotlit agent shows WHERE it has been
 * working. Inside the selection a hover is admitted and NARROWS
 * (`wiringTarget`, hoverSelection.ts): pointing at one of the lit files
 * re-answers about that file — its own folders, its threads, the tables it
 * touches, the agents holding it — and letting go returns the map to the
 * selection. Narrowing ADDS an answer rather than replacing one: the
 * selection's own wiring stays drawn a step quieter behind the hovered file's
 * (`hoverRecession` / `threadPresence`, hoverLayers.ts), so a pinned table
 * keeps its ropes out to all of its files and a spotlit agent keeps its
 * tethers while she reads one of them. Before that, pointing at a member
 * collapsed the selection to that one dot. The picked-out body
 * itself never dims (`isSubject`), so narrowing can't cancel it. The faded
 * dots stay silent under a selection because they can't be pointed at at all,
 * not because the label pass refuses them; the dot she CAN point at names
 * itself as always, and picks itself out of the selection's other names,
 * which step back. One fade, `UNSELECTED_FADE`, for everything outside
 * a selection, whichever of the three it is — and the touch rings recede on
 * it alongside their dots.
 *
 * Hovering a table also draws a rope out to every CODE FILE that touches it,
 * named where it lands (`setTableCodeLinks`, and the rope pass just before
 * the edges). Only under a hover, and only the hovered body's own ropes —
 * every pair at once would be a mat across the whole map. Symmetric: hovering
 * one of those files draws the same ropes back to the tables it touches — and
 * with a table PINNED, the rope home to it keeps the database blue while the
 * file's other tables are roped in a greyer one, so the table she picked
 * doesn't read as just another end.
 *
 * Prompt that produced it: "i want them to be sized by how much is in there
 * and learn more about the shapes of the tables through this exercise" / "a
 * little off in their own section of the personal vault and then more
 * organized" / "i would like for the sql databases to be positioned centrally
 * between the personal and the code database rather than being on the right
 * edge" / "i'm
 * wanting to connect my sql databases to files … when i hover over it to have
 * lines pop up connecting them to the files that created them and interact
 * with them" / "hovering over a file shows its name … i want them to
 * highlight the tables and files they're connected to on one click and a
 * double click opens it up".
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
import { forgetPins, recallLayout, rememberLayout } from './layoutMemory';
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
import type { TableCodeLink } from './tableMentions';
import { homeChain, wiringTarget } from './hoverSelection';
import { spiralSpots, type SpiralArrangement } from './spiralLayout';
import {
  chainGlow,
  chainLean,
  hoverRecession,
  threadPresence,
  threadTooCold,
} from './hoverLayers';
import { bodyRadius, NODE_GAP, sameRings } from './ringBodies';
import { fileTypeOf } from './fileTypes';
import { childTypeCounts, liveliestBeneath } from './folderTypes';
import {
  COLUMN_WIDTH,
  HEADER_HEIGHT,
  corridorLeft,
  shelfLayout,
  tableCollideRadius,
  tableSize,
  type ShelfLayout,
} from './tableNodes';

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
 * Sink a stale file into the sky under the "Types" toggle. Takes the dot's
 * type colour and returns what it actually wears: the full colour while the
 * file is alive, mixed further toward the surface the longer it's been since
 * anything touched it, and gone entirely once it's outside the Heat bar's
 * window. So Types still answers "what kind of file is this" for the code
 * she's working in, and the dead wood goes dark rather than shouting in the
 * same colour as the living.
 *
 * "Alive" is the union of both fires (glowOf) — edited OR run — and the fade
 * curve is
 * glowAlpha, the very curve the ember hue fades on over ash. That's on
 * purpose: under Types the type colour simply takes the ember hue's place, so
 * a dot goes out at exactly the moment it would have gone out under heat —
 * at the thumb. Which makes the Heat slider the staleness dial here too: drag
 * it right and older files come back.
 *
 * Prompt that produced it: "i want to hide stale files on the terrain page …
 * i'm wanting for the dots to turn black or to disappear when i am on the
 * 'types' display".
 */
export function staleTypeColor(typeColor: string, bg: string, t: number, a: number): string {
  return mixHex(bg, typeColor, glowAlpha(glowOf(t, a)));
}

/** How much of its presence a LINE keeps once the file it lands on has gone
 * stale. Half, not nothing — the dot can leave, but the line it hung from
 * still has to say the file is there. */
const STALE_EDGE_FLOOR = 0.5;

/**
 * Fade a line along with the dot it lands on, under the "Types" toggle. Same
 * staleness and the same curve as staleTypeColor above, so a line dims in step
 * with its own dot rather than on a rule of its own — but it lands at half
 * presence instead of at nothing. A dot that's gone dark with a full-strength
 * line still running to it reads as a mistake, and a folder whose lines all
 * vanished reads as an empty folder; half keeps the shape of the tree legible
 * while letting the live files have the eye.
 *
 * Prompt that produced it: "i also want the lines that go to the dots to be
 * faded too … maybe like 50% opacity. to show they're 'there' but not be so
 * prominent as the others".
 */
export function staleTypeAlpha(t: number, a: number): number {
  return STALE_EDGE_FLOOR + (1 - STALE_EDGE_FLOOR) * glowAlpha(glowOf(t, a));
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

/** How warm the sim runs while she's carrying a node — enough that the
 * neighbours make room around it, far too little to re-arrange the map. */
const DRAG_ALPHA = 0.1;

/** A click that lands within this of a drag ending is the drag's own click,
 * not a tap: she moved a dot, she didn't ask to open it. */
const DRAG_CLICK_GRACE_MS = 250;

/** How often the layout is allowed to be written down while she's working.
 * The saves that have no second chance (the page going away, a node put down)
 * skip it. */
const SAVE_THROTTLE_MS = 2_000;

/** Where a gesture started, in client coordinates — mouse and touch answer
 * that question differently, and the zoom filter has to ask it of both. */
function gesturePoint(event: Event): { clientX: number; clientY: number } | null {
  const touches = (event as TouchEvent).touches;
  if (touches && touches.length > 0) return { clientX: touches[0].clientX, clientY: touches[0].clientY };
  const mouse = event as MouseEvent;
  return Number.isFinite(mouse.clientX) ? { clientX: mouse.clientX, clientY: mouse.clientY } : null;
}
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

/** How much of itself a body keeps when it is NOT part of what she picked out.
 * One number for all three selections — a spotlit agent, a pinned table, a
 * search — because they are the same gesture as far as the eye is concerned:
 * "this, and not those". Faded, never gone: the rest of the map stays on
 * screen as context, which is the whole reason a spotlight beats a filter.
 *
 * Prompt that produced it: "i want things to function with a hybrid of how
 * things work now between the agents and the sql. i want the rings to remain
 * in the canvas, but i want them to be faded for both of them when they are
 * not connected to the thing that i've selected". */
const UNSELECTED_FADE = 0.22;
/** How much of itself a NAME keeps when the cursor has picked out a different
 * name in the same set. Deliberately gentler than UNSELECTED_FADE — these
 * labels were asked for and are still being read; the hover is only saying
 * which one of them is under the cursor. Same 0.3 the orb titles and the
 * shelf names already step back to. */
const NAMED_FADE = 0.3;

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
 * stands for — see tableNodes.ts.) Tables are the one thing the physics does
 * NOT place: each is pinned to its spot on the shelves (placeShelves), and
 * keeps only a collision circle so stray dots are pushed off it. */
function isTable(n: SimNode): boolean {
  return n.node.file?.table !== undefined;
}

/**
 * How fast a dot slides out to its place on the coil, per tick.
 *
 * This is the "snakes out in a chain" — a dot that has just joined the coil
 * is born at the centre and eases out along the strand to its spot, so
 * widening the window pays the chain out from the middle rather than
 * flickering a hundred dots into existence at once.
 *
 * Only the DOTS ease. The coil's collision body is its final size from the
 * first frame, so the ground clears at once and the chain then fills the
 * clearing — and because d3 reads a collision radius once, in the force's
 * initialize(), an eased body would have been a number nothing was reading
 * anyway.
 */
const COIL_EASE = 0.14;

/** A table is never drawn narrower or shorter than this many SCREEN pixels, so
 * zooming far out leaves a field of small marks rather than nothing. Same idea
 * as MIN_NODE_PX. */
const TABLE_MIN_PX = 3;
/** Tables are named from much further out than folders are (LABEL_MIN_K): a
 * rectangle with no name teaches nothing, and the label pass already skips any
 * name that would overlap another, so showing them early costs no clutter —
 * pulled back, only the names that fit appear. */
const TABLE_LABEL_MIN_K = 0.16;
/** The smallest body a table gets in the physics, whatever its rectangle. */
const TABLE_MIN_COLLIDE_R = 30;
/** The clear ground between the outer edge of the vault's dots and the
 * shelves. The shelf names hang in this gap, right-aligned against the
 * shelves, and they are drawn at a fixed SCREEN size — so at the pulled-back
 * zooms the map is usually read at, a 100px name covers ~200 of these world
 * units. The margin is that plus breathing room. Judged by eye. */
const SHELF_MARGIN = 480;
/** The shelves' keep-out zone: the section's own rectangle grown by this much
 * on every side. A dot inside it is pushed back out (see the 'shelfKeepOut'
 * force). Deliberately smaller than SHELF_MARGIN, so the zone's edge sits in
 * the clear ground between the vault and the shelves — a dot resting at the
 * vault's outer edge is never inside it, and the two rules can't fight. */
const SHELF_KEEP_OUT_PAD = 160;
/** Extra keep-out on the section's LEFT, where the shelf names hang (they are
 * right-aligned to end just before each shelf begins). The names are drawn at
 * a fixed SCREEN size, so at the pulled-back zooms the map is read at they
 * cover a few hundred world units; without this a dot parks underneath them
 * and the names become unreadable. Judged by eye, same as SHELF_MARGIN. */
const SHELF_NAME_GUTTER = 360;
/** Breathing room on top of the corridor the section needs: how much clear
 * ground is left between the section's keep-out zone and where each repo's
 * dots are pulled. Without it the two rules rest exactly against each other
 * and the dots sit pressed to the section's edge. */
const SHELF_CORRIDOR_CLEAR = 260;
/** How hard a dot inside the keep-out zone is pushed, per tick, as a share of
 * how deep inside it is. Firm enough to clear a dot in a second or so, soft
 * enough that it slides out rather than being flung across the map. */
const SHELF_KEEP_OUT_PUSH = 0.35;
/** The shelves re-measure where the dots are once every this many physics
 * ticks — often enough to glide with the map as it settles, rare enough that
 * walking a few thousand positions costs nothing noticeable. */
const SHELF_SETTLE_EVERY = 8;

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

/**
 * A folder node's outline — the corner points, before any rounding.
 *
 * Folders and repos are drawn as FOLDERS rather than as circles, because the
 * map's shapes already mean something: circles are things (files, agents),
 * rectangles are places you put things (the pond, the table shelves). A
 * folder is a place. Before this, a folder was a circle that differed from a
 * file only in tone, so the structure and its contents read as one soup.
 *
 * They're drawn HOLLOW — outline only, no fill — for the same reason: a
 * folder is a container, and an unfilled one leaves the files inside it as
 * the thing being looked at. What the outline is painted with is the draw
 * loop's call, and it follows whichever lens the map is lit by.
 *
 * The bounding box is the SAME at every zoom. Far out, that box is all there
 * is — a plain rounded rectangle. Once the body is tall enough on screen to
 * show it, the tab is cut DOWN into the top edge rather than added on top, so
 * the silhouette never grows or jumps as she zooms: the notch simply appears
 * inside the shape she was already looking at. (Same level-of-detail instinct
 * as the tables, which drop their column bands when they get small.) A notch
 * a pixel deep is noise on an outline, not a folder, which is what the
 * threshold is for.
 *
 * Pure — the caller rounds the corners and paints it (roundedPolygonPoints).
 *
 * Prompt that produced it: "i'm wondering if the folder nodes should be a
 * different shape and or color … maybe a literal folder, and when i'm zoomed
 * out it just shows a rounded square or rectangle in the shape the folder is".
 */
export const FOLDER_TAB_MIN_PX = 13;
/** The smallest share of a folder that earns its own slice of the outline,
 * and the most slices one folder is ever cut into. Past either, the tail
 * becomes a single neutral slice — see folderSharesOf. */
const MIN_FOLDER_SHARE = 0.08;
const MAX_FOLDER_SHARES = 5;
/** The box a folder of radius r fills — a little wider than tall, the way a
 * folder is, and about the footprint the circle it replaced had. */
export function folderBox(r: number): { width: number; height: number } {
  return { width: r * 2.1, height: r * 1.55 };
}
export function folderOutline(
  cx: number,
  cy: number,
  r: number,
  screenScale: number,
): [number, number][] {
  const { width, height } = folderBox(r);
  const left = cx - width / 2;
  const right = cx + width / 2;
  const top = cy - height / 2;
  const bottom = cy + height / 2;
  // Too small on screen for a notch to read: the box, and nothing else.
  if (height * screenScale < FOLDER_TAB_MIN_PX) {
    return [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ];
  }
  // The tab keeps the left of the top edge; the body's own top steps down
  // behind it, joined by a short slanted shoulder so the step reads as a
  // folder rather than as a bite taken out of a rectangle.
  const tabHeight = height * 0.26;
  const tabRight = left + width * 0.44;
  const bodyTop = top + tabHeight;
  return [
    [left, top],
    [tabRight, top],
    [tabRight + tabHeight * 0.8, bodyTop],
    [right, bodyTop],
    [right, bottom],
    [left, bottom],
  ];
}

/** How many straight steps a rounded corner is drawn in. Eight is past the
 * point where the facets show at this map's zoom, and keeps a folder's whole
 * outline under fifty points — small enough to walk per frame. */
const CORNER_STEPS = 8;

/**
 * Round the corners of a closed outline and flatten the result into a plain
 * polyline — a list of points, first joined back to last.
 *
 * Flattened rather than left as arcs because the caller doesn't only fill and
 * stroke this shape: it walks it BY LENGTH, to paint each file type its share
 * of a folder's border. A canvas path can't be measured or cut; a polyline
 * can, and at eight steps a corner the two are indistinguishable on screen.
 *
 * Each corner is replaced by the arc that runs tangent to both of its edges,
 * shrunk if it wouldn't fit on the shorter one. Concave corners work the same
 * way as convex ones, which is what lets the folder tab's shoulder round like
 * every other corner instead of staying a spike.
 */
export function roundedPolygonPoints(
  points: readonly [number, number][],
  radius: number,
): [number, number][] {
  const count = points.length;
  const out: [number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    const [x, y] = points[i];
    const [prevX, prevY] = points[(i + count - 1) % count];
    const [nextX, nextY] = points[(i + 1) % count];
    const prevLen = Math.hypot(x - prevX, y - prevY);
    const nextLen = Math.hypot(nextX - x, nextY - y);
    if (prevLen === 0 || nextLen === 0) {
      out.push([x, y]);
      continue;
    }
    // Unit vectors pointing away from the corner, back along each of its two
    // edges. The angle between them is the corner's own angle.
    const inX = (prevX - x) / prevLen;
    const inY = (prevY - y) / prevLen;
    const outX = (nextX - x) / nextLen;
    const outY = (nextY - y) / nextLen;
    const halfAngle = Math.acos(Math.max(-1, Math.min(1, inX * outX + inY * outY))) / 2;
    // A corner that isn't one — a straight run, or a fold back on itself —
    // has no arc to draw.
    if (!Number.isFinite(halfAngle) || halfAngle < 1e-4 || Math.PI / 2 - halfAngle < 1e-4) {
      out.push([x, y]);
      continue;
    }
    // Shrink the arc until it fits: it reaches this far down each edge, and
    // two corners are never allowed to eat the same half of an edge.
    let reach = radius / Math.tan(halfAngle);
    let arcRadius = radius;
    const room = Math.min(prevLen, nextLen) / 2;
    if (reach > room) {
      reach = room;
      arcRadius = reach * Math.tan(halfAngle);
    }
    // The arc's centre sits along the corner's bisector, far enough in that
    // the arc just touches both edges.
    let bisectorX = inX + outX;
    let bisectorY = inY + outY;
    const bisectorLen = Math.hypot(bisectorX, bisectorY);
    if (bisectorLen < 1e-9) {
      out.push([x, y]);
      continue;
    }
    bisectorX /= bisectorLen;
    bisectorY /= bisectorLen;
    const centreX = x + bisectorX * (arcRadius / Math.sin(halfAngle));
    const centreY = y + bisectorY * (arcRadius / Math.sin(halfAngle));
    const from = Math.atan2(y + inY * reach - centreY, x + inX * reach - centreX);
    const to = Math.atan2(y + outY * reach - centreY, x + outX * reach - centreX);
    // Always take the short way round, whichever direction that turns out to
    // be — the long way would loop the arc back across the shape.
    let sweep = to - from;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    for (let step = 0; step <= CORNER_STEPS; step += 1) {
      const angle = from + (sweep * step) / CORNER_STEPS;
      out.push([centreX + Math.cos(angle) * arcRadius, centreY + Math.sin(angle) * arcRadius]);
    }
  }
  return out;
}

/** Lay a closed polyline into the current path. Leaves it current so the
 * caller can fill it, stroke it, or both. */
function tracePolyline(ctx: CanvasRenderingContext2D, polyline: readonly [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(polyline[0][0], polyline[0][1]);
  for (let i = 1; i < polyline.length; i += 1) ctx.lineTo(polyline[i][0], polyline[i][1]);
  ctx.closePath();
}

/**
 * Paint a closed polyline in coloured slices — each one taking the share of
 * the outline its `fraction` asks for, in order, starting where the polyline
 * starts.
 *
 * This is GitHub's language bar bent around the shape: it's how a folder says
 * what MIX of things is inside it rather than just naming its commonest. The
 * alternative — blending the type colours into one — would land on a colour
 * that means nothing, or worse, on some third type's colour: these are
 * CATEGORY colours, and the space between two of them isn't a category.
 * Proportion is the thing that can be averaged here; hue isn't.
 *
 * Fractions are taken as given and are expected to sum to 1; anything past
 * the end of the outline is simply not drawn.
 *
 * Prompt that produced it: "shouldn't the outline be like an average of the
 * children".
 */
function strokePolylineShares(
  ctx: CanvasRenderingContext2D,
  polyline: readonly [number, number][],
  shares: readonly { color: string; fraction: number }[],
): void {
  const count = polyline.length;
  // Measure once: how long each step is, and how long the whole loop is.
  const steps: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const [x, y] = polyline[i];
    const [nextX, nextY] = polyline[(i + 1) % count];
    const len = Math.hypot(nextX - x, nextY - y);
    steps.push(len);
    total += len;
  }
  if (total === 0) return;
  let from = 0;
  for (const share of shares) {
    const to = from + share.fraction * total;
    // Cut the run between `from` and `to` out of the loop: walk the steps,
    // skip the ones outside it, and clip the two it starts and ends inside.
    ctx.beginPath();
    let cursor = 0;
    let started = false;
    for (let i = 0; i < count; i += 1) {
      const stepStart = cursor;
      const stepEnd = cursor + steps[i];
      cursor = stepEnd;
      if (steps[i] === 0 || stepEnd <= from || stepStart >= to) continue;
      const [x, y] = polyline[i];
      const [nextX, nextY] = polyline[(i + 1) % count];
      const enter = Math.max(0, (from - stepStart) / steps[i]);
      const exit = Math.min(1, (to - stepStart) / steps[i]);
      if (!started) {
        ctx.moveTo(x + (nextX - x) * enter, y + (nextY - y) * enter);
        started = true;
      }
      ctx.lineTo(x + (nextX - x) * exit, y + (nextY - y) * exit);
    }
    if (started) {
      ctx.strokeStyle = share.color;
      ctx.stroke();
    }
    from = to;
  }
}

function nodeRadius(node: TerrainNode, t: number): number {
  if (node.kind === 'repo') return 11;
  if (node.kind === 'session') return 9; // orbs: fixed — identity, not magnitude
  if (node.kind === 'dir') return 5.5 + 4.5 * t;
  // The pond tile: a body the size of its square, so the sim keeps the rest
  // of the map out from under it.
  if (node.file?.days) return POND_TILE_COLLIDE_R;
  // A table: the circle that encloses its rectangle, for the same reason.
  // Never less than TABLE_MIN_COLLIDE_R, so even a two-column sliver of a
  // table has enough body to push a stray dot off itself.
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
  /** Table-to-code ropes: which code files touch which table (tableMentions.ts
   * tableCodeLinks). Drawn only under a hover, and — like the threads — never
   * handed to the physics: a spring from a pinned shelf to a file dot would
   * drag the file across the map. Empty until the page hands them over. */
  private tableCodeLinks: readonly TableCodeLink[] = [];
  /** Either end of a rope → the node ids at its other ends. The hover reads
   * this; it is rebuilt only when the ropes or the graph change. */
  private codeLinkKin = new Map<string, Set<string>>();
  /** Which agent orbs have touched which files, either direction — the tether
   * edges read as a lookup. What keeps an agent lit when the cursor is on one
   * of its files. Rebuilt with the graph, never in the draw loop. */
  private sessionKin = new Map<string, Set<string>>();
  /** The folder node(s) the tables hang off (`exo.db`) — pinned at the head of
   * the shelves, and excused from the ordinary folder spring. */
  private shelfHubIds = new Set<string>();
  /** The table section, once there are tables: its arrangement, which side
   * of its repo it stands on, the nodes it pins, and where its top-left
   * corner currently is in WORLD units (null until first measured). */
  private shelf: {
    layout: ShelfLayout;
    repoId: string;
    outward: 1 | -1;
    /** True when the section stands in the corridor BETWEEN the repos rather
     * than out past the far edge of its own. Needs another repo to be between
     * — with one repo on the map there is no corridor. */
    between: boolean;
    tables: SimNode[];
    hubs: SimNode[];
    left: number | null;
    top: number | null;
  } | null = null;
  /** Physics ticks since the graph was last laid out — paces settleShelves. */
  private ticksSinceLayout = 0;
  /** True once she has panned or zoomed by hand. */
  private cameraIsHers = false;
  /**
   * Whether this engine keeps its layout across mounts (layoutMemory.ts). Only
   * the real map opts in: the ambient backdrop draws the same graph as
   * wallpaper on a canvas of a different size, and letting it write would hand
   * the page back somebody else's camera.
   */
  private remembers = false;
  /** The nodes SHE dragged into place, by id. Each is held at its spot (d3's
   * fx/fy) until she releases it or reloads the page. */
  private pinnedByHand = new Set<string>();
  /** The node currently being carried, and the pointer carrying it. */
  private dragNode: SimNode | null = null;
  private dragPointerId: number | null = null;
  /** Whether that pointer has actually moved — a press that never moved is a
   * tap, and still has to open the file. */
  private dragMoved = false;
  /** When the last real drag ended, so its trailing click can be swallowed. */
  private draggedAt = 0;
  /** When the layout was last written down — see SAVE_THROTTLE_MS. */
  private lastSaveAt = 0;
  /** Set when the table shelves first appear: frame the whole map once more
   * when the physics settles — unless she has taken the camera by then. */
  private refitWhenSettled = false;
  /** Every node's parent, by id — the tree, one step at a time, so a dot can
   * be asked which folders it sits inside (homeChain) without walking the
   * whole node list. Rebuilt with the graph. */
  private parentById = new Map<string, string | null>();
  /** Everything the LIT body is wired to, itself included — recomputed only
   * when the lighting changes, not per frame. */
  private hoverFileKin: Set<string> = new Set();
  /** The same for the PINNED table, held apart because a hover inside the
   * pin's answer narrows onto one member and moves hoverFileKin with it. This
   * set is what the pin NAMED — what stays touchable, and what a hover has to
   * land inside to count at all — so it must not move when the cursor does. */
  private heldFileKin: Set<string> = new Set();
  /** The spotlight, plus the folders everything in it is kept in. What the
   * map actually paints in full while a selection is up (`footprint` itself
   * stays the raw membership: what the selection named, and what can still be
   * touched). Rebuilt when the spotlight changes or the tree moves. */
  private footprintLit: Set<string> | null = null;
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
   * How each folder's outline is split under "Types": the file types beneath
   * it (folderTypes.ts) as coloured shares of its border, commonest first and
   * already lifted for the surface.
   *
   * Rebuilt only when its answer could have changed — a new graph, a new
   * surface, or a different set of files hidden by the date range. The hidden
   * set is compared BY IDENTITY, because the page hands over a freshly built
   * Set only when the range actually moved; under Dynamic that would otherwise
   * be a full roll-up every frame.
   */
  private folderShareCache: Map<string, { color: string; fraction: number }[]> | null = null;
  private folderSharesKey: ReadonlySet<string> | null = null;
  /**
   * How present each folder is under "Types", 0..1 — the aliveness of the
   * liveliest file anywhere beneath it (folderTypes.ts liveliestBeneath), on
   * the same curve the file dots fade out on. Zero for a folder with nothing
   * live inside, which paints as nothing at all. Built and thrown away with
   * folderShareCache, off the same walk.
   */
  private folderFadeCache: Map<string, number> = new Map();
  /**
   * File dots the date range has put outside the span (TerrainPage
   * filesOutsideRange) — the only thing that hides a file dot now. Hidden is
   * a PAINT decision, not a layout one: these dots stay in the sim and keep
   * their places, so narrowing the range moves nothing — they just aren't
   * drawn, their tree edges and tethers and threads aren't drawn, and a tap
   * can't land on them.
   */
  private hiddenFiles: ReadonlySet<string> = new Set();
  /**
   * The Active bar's set: every file that RAN inside the window the bar is set
   * to (runGlow.ts). These dots take a gold halo and nothing else on the map
   * changes — no dimming, no hiding, no layout. Additive on purpose: the two
   * dimming rules that already exist (a tapped agent's footprint, a hovered
   * file's kin) fight each other if a third joins them, so this one only ever
   * ADDS light.
   */
  private glowFiles: ReadonlySet<string> = new Set();
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
  /** The FILE dot under the cursor, whatever it is — the one that names
   * itself. Deliberately not hoverFile: that one is the wiring highlight and
   * refuses a dot with nothing wired to it, which is exactly the dot whose
   * name is worth showing. Mouse-only, like every hover here.
   *
   * Prompt that produced it: "i want it such that hovering over a file shows
   * its name". */
  private hoverLabel: string | null = null;
  /** A file or table whose wiring is pinned lit regardless of the cursor —
   * set by a click (see holdFileHover), the way heldHover pins an agent. */
  private heldFile: string | null = null;
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

  /**
   * The uploads coil: the archive's folder node with its month of uploads
   * wound around it in a spiral (uploadNodes.ts picks them, spiralLayout.ts
   * places them).
   *
   * This is the map's THIRD arrangement the physics doesn't decide, after the
   * pond tile and the table shelves, and it borrows from both. Like the
   * shelves, every dot is pinned to a spot a pure function worked out, so the
   * coil keeps its shape instead of being combed out by the springs. Like the
   * pond, the whole thing is ONE body as far as the collider is concerned —
   * the folder node carries a collision circle the size of the coil, so the
   * terrain bumps around the outside of it rather than threading through the
   * arms.
   *
   * The hub itself is NOT pinned: it floats on the ordinary repo anchor and
   * finds its own place on the map, and the dots ride wherever it lands. That
   * is why the pins below are offsets from the hub and not absolute points —
   * an absolute pin would smear the coil behind the hub every time the hub
   * moved.
   */
  private coil: {
    hub: SimNode;
    /** In coil order: innermost (newest upload) first. */
    dots: SimNode[];
    arrangement: SpiralArrangement;
    /** Each dot's CURRENT offset from the hub, eased toward its spot. A dot
     * that has just joined starts at the centre and slides out. */
    offsets: { x: number; y: number }[];
  } | null = null;
  /** The coil's dots in order, and the folder they wind around, as handed in
   * by the page. Held separately from `coil` because they arrive before the
   * graph that resolves them into nodes. */
  private coilIds: readonly string[] = [];
  private coilFolderId: string | null = null;
  /** What the coil says about itself under its own name — the window it's
   * open to and how much of the archive that is. The engine doesn't know
   * either fact; the page does, and hands the finished line over. */
  private coilCaption: string | null = null;
  /** Fast membership for the forces and the paint — rebuilt with the coil. */
  private coilDotIds: ReadonlySet<string> = new Set();

  onTap: ((node: TerrainNode | null) => void) | null = null;
  /** How many nodes she's dragged into place, reported whenever that changes —
   * what the page's "release" control counts. */
  onPins: ((count: number) => void) | null = null;
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

  constructor(
    canvas: HTMLCanvasElement,
    theme: ThemeInk,
    opts?: { ambient?: boolean; remember?: boolean },
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.theme = theme;
    this.ambient = opts?.ambient === true;
    this.remembers = opts?.remember === true;
    this.fontFamily =
      getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || this.fontFamily;

    this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .clickDistance(8) // pans suppress the click; taps still land
      // A gesture that starts ON a draggable node belongs to that node, not to
      // the camera — the drag handlers below take it and d3-zoom never sees it.
      // The rest is d3's own default filter: no secondary button, no ctrl-drag,
      // wheel always allowed.
      .filter((event: Event) => {
        const mouse = event as MouseEvent;
        if (mouse.button) return false;
        // A wheel is always the camera's — and hit-testing one would cost a
        // scan of the whole map per wheel event, dozens per scroll.
        if (event.type === 'wheel') return true;
        if (mouse.ctrlKey) return false;
        // A second finger is a pinch, whatever the first one landed on.
        const touches = (event as TouchEvent).touches;
        if (touches && touches.length > 1) return true;
        const point = gesturePoint(event);
        return point === null || !this.canDrag(this.nodeAt(point));
      })
      .on('zoom', (event: { transform: ZoomTransform; sourceEvent?: unknown }) => {
        this.transform = event.transform;
        // A zoom with a real gesture behind it means SHE moved the camera; one
        // the engine asked for has no source event. Remembered so a late
        // re-frame (the table shelves arriving) never yanks a view she chose.
        if (event.sourceEvent) this.cameraIsHers = true;
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
      this.canvas.addEventListener('pointerdown', this.handlePointerDown);
      this.canvas.addEventListener('pointerup', this.handlePointerUp);
      this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    }

    // Come back to the camera she left. Restoring it counts as hers, so the
    // once-only fit never yanks the view back out to the whole map.
    const camera = this.remembers ? (recallLayout()?.camera ?? null) : null;
    if (camera) {
      select(this.canvas).call(
        this.zoomBehavior.transform,
        zoomIdentity.translate(camera.x, camera.y).scale(camera.k),
      );
      this.cameraIsHers = true;
    }

    document.addEventListener('visibilitychange', this.handleVisibility);
    // The reload path. `pagehide` is the one event that fires reliably across
    // desktop and iOS on the way out; visibilitychange covers a PWA that's
    // backgrounded and then killed without ever firing it.
    if (this.remembers) {
      window.addEventListener('pagehide', this.handlePageHide);
      document.addEventListener('visibilitychange', this.handlePageHide);
    }
    this.orbStroke = theme.accent; // agent + its dotted tethers = the app --accent (her 07-26 call)
  }

  /**
   * Write the map down — positions, her pins, the camera (layoutMemory.ts).
   * Called whenever the map goes still, whenever she finishes moving something,
   * and, the one that matters for a reload, as the page goes away: a reload
   * never runs React's cleanup, so saving only on destroy saved nothing at all
   * on a hard refresh. Throttled; `force` is for the saves with no second
   * chance.
   */
  private saveLayout(force = false): void {
    if (!this.remembers || this.simNodes.length === 0) return;
    const now = performance.now();
    if (!force && now - this.lastSaveAt < SAVE_THROTTLE_MS) return;
    this.lastSaveAt = now;
    rememberLayout(
      this.simNodes.map((n) => ({
        id: n.id,
        x: n.x,
        y: n.y,
        pinned: this.pinnedByHand.has(n.id),
      })),
      { x: this.transform.x, y: this.transform.y, k: this.transform.k },
    );
  }

  /** The page is going away — a reload, a closed tab, a phone backgrounding the
   * PWA. Last chance to write, and it has to be synchronous. */
  private handlePageHide = (): void => {
    this.saveLayout(true);
  };

  destroy(): void {
    this.saveLayout(true);
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
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('pagehide', this.handlePageHide);
    document.removeEventListener('visibilitychange', this.handlePageHide);
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
    this.folderShareCache = null; // and so are the folder outlines built from them
    this.requestDraw();
  }

  /** Turn the "Types" colouring on or off (typeColorPref.ts). Pure lighting:
   * no camera move, no sim wake, one repaint when it flips. */
  setTypeColors(on: boolean): void {
    if (this.typeColors === on) return;
    this.typeColors = on;
    this.requestDraw();
  }

  /** Hand over the file dots to hide — only the date range does this now
   * (TerrainPage filesOutsideRange). Pure lighting: no camera move, no sim
   * wake, one repaint. */
  setHiddenFiles(ids: ReadonlySet<string>): void {
    if (this.hiddenFiles !== ids) this.folderShareCache = null; // folders describe what's still shown
    this.hiddenFiles = ids;
    this.requestDraw();
  }

  /** Hand over the file dots to light up — the ones that ran inside the Active
   * bar's window (runGlow.ts). Pure lighting, exactly like setHiddenFiles: no
   * camera move, no sim wake, one repaint. */
  setGlowFiles(ids: ReadonlySet<string>): void {
    this.glowFiles = ids;
    this.requestDraw();
  }

  /**
   * Hand over the spotlight — an agent's files and orb, or a search's hits.
   *
   * What it paints is that set PLUS the folders everything in it is kept in
   * (`footprintLit`), so a spotlit agent shows where it has been working and
   * not just which dots it touched. The raw set is kept as well: it's what the
   * selection actually named, so it stays the test for what can be touched.
   *
   * Prompt that produced it: "i want the folders that each is connected to to
   * also light up".
   */
  setFootprint(footprint: Set<string> | null): void {
    this.footprint = footprint;
    this.footprintLit = footprint === null ? null : this.withHomes(footprint);
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
   * map to clear. An identical set arriving again changes nothing at all —
   * see sameRings for why that test has to be on the contents. */
  setAgentRings(rings: Map<string, FileTouchKind>): void {
    if (sameRings(this.agentRings, rings)) return;
    this.agentRings = rings;
    this.reshapeBodies();
    this.requestDraw();
  }

  /** Is this node wearing a touch ring right now? Deliberately does NOT ask
   * hoverRings: those rewrite themselves as the cursor moves, and a map that
   * re-arranges itself under the mouse is unusable. Physics follows the fact,
   * paint follows the cursor. */
  private isRinged(n: SimNode): boolean {
    return n.node.kind === 'file' && (this.focusRings.has(n.id) || this.agentRings.has(n.id));
  }

  /** This node's body in world units — the circle the collider reserves and
   * the circle the ring is drawn on. The single number behind both; see
   * ringBodies.ts. */
  private bodyRadiusOf(n: SimNode): number {
    // The coil's folder carries the whole spiral as its body — the same move
    // the pond tile makes, and for the same reason: a hundred pinned dots the
    // collider knows nothing about would have the rest of the map threading
    // straight through the arms. One circle, the size of the coil, and the
    // terrain flows around the outside of it.
    if (this.coil !== null && n.id === this.coil.hub.id) {
      return this.coil.arrangement.outerRadius + NODE_GAP;
    }
    return bodyRadius(n.radius, this.isRinged(n));
  }

  /**
   * Re-measure the bodies after the ring set changed, then let the map make
   * room.
   *
   * d3 reads each node's collision radius and each rope's rest length ONCE,
   * in the force's initialize(), and caches them in an array — it never asks
   * the accessor again. So a ring appearing is invisible to the physics until
   * those forces are re-initialized, and handing a force back to the
   * simulation under its own name is what re-runs that measurement.
   *
   * Then the faintest warmth: enough that the neighbours step back around a
   * dot that just grew, far too little to re-arrange the map — the same heat
   * a node being carried gets (DRAG_ALPHA).
   */
  private reshapeBodies(): void {
    this.remeasureBodies();
    const sim = this.sim;
    if (sim && sim.alpha() < DRAG_ALPHA) sim.alpha(DRAG_ALPHA).restart();
  }

  /** The measuring half of reshapeBodies, without waking anything: the forces
   * ask for every radius and rest length again, and use them whenever the sim
   * next runs. This is what the in-place heat path calls — a dot growing with
   * its heat changes its body too, and leaving the collider on the radii it
   * cached at the last rebuild is how a swollen dot ends up with a ring lying
   * over its neighbour. Cheap enough to do at the breath's cadence; a wake is
   * not, which is why that stays with ring changes. */
  private remeasureBodies(): void {
    const sim = this.sim;
    if (!sim) return;
    for (const name of ['collide', 'link'] as const) {
      const force = sim.force(name);
      if (force) sim.force(name, force);
    }
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

  /** The run halo — this file RAN inside the Active bar's window. A gold ring
   * just outside the dot, gold because running is the gold fire everywhere
   * else on this map (terrainGraph.ts RUN_WINDOW_SECONDS).
   *
   * Binary, not a freshness ramp: the bar's window already decides what counts
   * as recent, and fading the ring by age would re-state what the dot's own
   * gold channel is saying underneath it. One ring, one strength — "this is
   * one of them".
   *
   * Drawn OUTSIDE the body so it reads on a dot of any colour, including a
   * Types-view dot that has no heat colour left. Its alpha multiplies into
   * whatever the dimming rules already set, the same way drawWriteCore does,
   * so a haloed dot inside a dimmed region dims with its surroundings instead
   * of punching through them. */
  private drawRunHalo(n: SimNode, nr: number): void {
    if (!this.glowFiles.has(n.id)) return;
    const { ctx, transform } = this;
    // Sit the ring clear of the dot's edge at every zoom: proportional when
    // the dot is big, a fixed screen gap when it's small, so a 4px dot still
    // gets a ring around it rather than a smudge on top of it.
    const radius = Math.max(nr * 1.5, nr + 3 / transform.k);
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * 0.85;
    ctx.strokeStyle = GOLD_HOT;
    ctx.lineWidth = 2 / transform.k;
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, radius, 0, Math.PI * 2);
    ctx.stroke();
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
    this.reshapeBodies();
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
    if (this.hoverFile !== null || this.heldFile !== null) this.recomputeHoverKin();
    this.requestDraw();
  }

  /**
   * Hand over the table-to-code ropes: which code files touch which table.
   *
   * The same contract as setThreads above — stored and drawn, never given to
   * the physics. Cheap to call whenever the graph or the tables payload
   * changes; anything already hovered has its kin rebuilt against the new
   * ropes, so a refeed can't leave the highlight pointing at a rope that no
   * longer exists.
   *
   * Prompt that produced it: "i'm wanting to connect my sql databases to
   * files … when i hover over it to have lines pop up connecting them to the
   * files that created them and interact with them".
   */
  setTableCodeLinks(links: readonly TableCodeLink[]): void {
    this.tableCodeLinks = links;
    this.codeLinkKin = new Map();
    for (const link of links) {
      if (!this.codeLinkKin.has(link.tableId)) this.codeLinkKin.set(link.tableId, new Set());
      if (!this.codeLinkKin.has(link.fileId)) this.codeLinkKin.set(link.fileId, new Set());
      this.codeLinkKin.get(link.tableId)!.add(link.fileId);
      this.codeLinkKin.get(link.fileId)!.add(link.tableId);
    }
    if (this.hoverFile !== null || this.heldFile !== null) this.recomputeHoverKin();
    this.requestDraw();
  }

  /** Everything a given body is wired to, itself included — its "answer".
   * Recomputed on a hover change, a pin, or a thread refeed; never in the draw
   * loop, which runs far more often. */
  private withHomes(ids: Iterable<string>): Set<string> {
    const lit = new Set(ids);
    for (const id of [...lit]) {
      for (const folder of homeChain(id, (child) => this.parentById.get(child) ?? null)) {
        lit.add(folder);
      }
    }
    return lit;
  }

  private kinOf(id: string | null): Set<string> {
    const kin = new Set<string>();
    if (id !== null) {
      kin.add(id);
      for (const th of this.threads) {
        if (th.sourceId === id) kin.add(th.targetId);
        else if (th.targetId === id) kin.add(th.sourceId);
      }
      // A hovered table keeps the tables it's joined to lit beside it.
      for (const other of this.foreignKeyKin.get(id) ?? []) kin.add(other);
      // ...and the code files that touch it, at the other end of the ropes
      // drawn below. Symmetric, so hovering one of those FILES lights the
      // tables it touches instead — the same question asked from either end.
      for (const other of this.codeLinkKin.get(id) ?? []) kin.add(other);
      // ...and the AGENTS that have touched it, which keep their colour and
      // their tether while the cursor is on one of their files. An agent
      // holding a file is as much a fact about the file as the folder it sits
      // in, and the dim shouldn't swallow the thing she picked out to look at.
      //
      // Prompt that produced it: "when i have an agent or an sql table
      // selected, i want it to retain the coloration for the agent or sql
      // table that it is connected to".
      for (const other of this.sessionKin.get(id) ?? []) kin.add(other);
    }
    // WHERE IT'S ALL KEPT: every folder anything in the answer sits inside, up
    // to its repo. The one answer every dot on the tree has — a file nothing
    // is joined to still lives somewhere — and it goes for the far ends of the
    // threads and ropes too, so the answer says where each of the things it
    // named is stored, not just the body she pointed at.
    //
    // Prompts that produced it: "when i hover over any given file, it dims
    // every other file and folder except for the folders that it's contained
    // within, so that i can see where the file is stored easily" / "i want the
    // folders that each is connected to to also light up".
    return this.withHomes(kin);
  }

  /**
   * What the SELECTION named, as node ids — a spotlit agent's footprint or a
   * pinned table's answer, and null when nothing is picked out.
   *
   * This is the set that keeps its lines while a file hover is up. Pointing at
   * one of a selection's own files used to throw the selection's wiring away
   * and describe that file instead; now the two answers stand together, and
   * this is the one that has to survive being narrowed onto (hoverLayers.ts).
   *
   * Prompt that produced it: "when i'm hovering over a dot that is selected by
   * an sql table or an agent, it can display the connection with the table or
   * agent as well as the connections to other tables or files".
   */
  private selectionAnswer(): Set<string> | null {
    if (this.footprint !== null) return this.footprintLit;
    if (this.heldFile !== null) return this.heldFileKin;
    return null;
  }

  /** Re-answer for whatever is lit — the cursor's dot, or the pin that
   * outranks it. */
  private recomputeHoverKin(): void {
    this.hoverFileKin = this.kinOf(this.hoverFile);
    this.heldFileKin = this.kinOf(this.heldFile);
  }

  /**
   * Is this body the one she has PICKED OUT — a spotlit agent's orb, or a
   * pinned table?
   *
   * The picked-out body keeps its full colour under any hover. A hover asks a
   * second question; it doesn't withdraw the first, and an orb that dimmed
   * while the cursor wandered would leave her selection looking cancelled.
   * The files around it still recede, so the hover is answered — it's only
   * the subject itself that holds.
   */
  private isSubject(n: SimNode): boolean {
    if (n.id === this.heldFile) return true;
    return this.footprint !== null && n.node.kind === 'session' && this.footprint.has(n.id);
  }

  /**
   * Is this body still TOUCHABLE, or is it scenery?
   *
   * While something is picked out, only what that selection named answers a
   * gesture: a spotlit agent's own files and orb, or a pinned table's answer.
   * Everything else stops being a thing — no drag, no pin, no tap, no cursor,
   * no hovercard — because a map narrowed to one agent's territory shouldn't
   * let a dot she was only sweeping past be picked up and moved. A press on
   * scenery pans the map, and a click on it clears the selection exactly as a
   * click on empty canvas does: that is the way back out.
   *
   * Asked by nodeAt, which every gesture goes through, so this is true or
   * false in ONE place rather than in five handlers.
   *
   * Prompt that produced it: "i don't want them interactable in any way
   * except the files that are selected by the agent selection".
   */
  private isTouchable(n: SimNode): boolean {
    if (this.footprint !== null) return this.footprint.has(n.id);
    if (this.heldFile !== null) return this.heldFileKin.has(n.id);
    return true;
  }

  /**
   * Point the wiring highlight at a file dot, or clear it.
   *
   * A hover only counts inside what's PICKED OUT, and the two ways of picking
   * something out are both handed to the rule here: the spotlight the page
   * set (`footprint` — an agent's files, or a search's hits) and the answer a
   * pinned table named (`heldFileKin`). hoverSelection.ts decides; this only
   * reports what's up. A hover outside comes back as the pin, or as nothing,
   * so sweeping the cursor across the rest of the map can't re-point it.
   */
  private setHoverFile(id: string | null): void {
    const inSelection =
      this.footprint !== null
        ? (other: string) => this.footprint!.has(other)
        : this.heldFile !== null
          ? (other: string) => this.heldFileKin.has(other)
          : null;
    const next = wiringTarget(id, this.heldFile, inSelection);
    if (next === this.hoverFile) return;
    this.hoverFile = next;
    this.recomputeHoverKin();
    this.requestDraw();
  }

  /**
   * Pin the wiring highlight to one file or table, or release it with null.
   *
   * The map's own answer to "click once to see what this is joined to, click
   * again to open it": the first click pins the threads, the foreign keys and
   * the code ropes lit so she can read them without holding the mouse still,
   * and the page decides what a second click on the same body means.
   *
   * What it names is then the only thing a gesture can land on, and the only
   * hover the map will answer: pointing at one of its rope-ends narrows onto
   * that file — its own folders, its threads, the other tables it touches —
   * with the pinned table holding its colour throughout, and the lighting
   * falling back to the pin when the cursor leaves. Releasing it is a second
   * click on it, or a click on empty canvas.
   *
   * Prompts that produced it: "i want them to highlight the tables and files
   * they're connected to on one click and a double click opens it up" / "if i
   * hover over each one, and it's connected to more things than just the sql
   * that i touch, it will also show those threads".
   */
  holdFileHover(id: string | null): void {
    this.heldFile = id;
    this.heldFileKin = this.kinOf(id);
    // Clearing the cursor's own hover is what makes the pin the lit body:
    // with nothing hovered the rule falls straight through to the pin.
    this.setHoverFile(null);
  }

  /** Name the dot under the cursor, or stop naming one. A label change is one
   * repaint and nothing else — no sim, no camera. */
  private setHoverLabel(id: string | null): void {
    if (this.hoverLabel === id) return;
    this.hoverLabel = id;
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
      // The dots just changed size, so their bodies did too — tell the forces.
      this.remeasureBodies();
      this.refreshDerived(nodes);
      this.requestDraw();
      return;
    }

    // New bodies, so the folder roll-up has to be counted again. The
    // update-in-place path above can't change it: same nodes, same paths.
    this.folderShareCache = null;
    const prev = new Map(this.simNodes.map((n) => [n.id, n]));
    // Where these nodes were the last time the page was open (layoutMemory.ts)
    // — read only on the FIRST graph of a mount, when there's nothing live to
    // carry over. A node that's remembered doesn't have to be laid out again,
    // and the ones she'd dragged come back still pinned.
    const recalled = this.remembers && prev.size === 0 ? (recallLayout()?.nodes ?? null) : null;
    let recalledHits = 0;
    const repoIds = [...new Set(nodes.filter((n) => n.repoId).map((n) => n.repoId))];
    // Work out the table section's shape before anything is placed, because
    // the repos have to be told to stand far enough apart to leave room for
    // it. Worked out here once and handed to placeShelves, rather than twice.
    const tables = nodes.filter((n) => n.file?.table !== undefined);
    const shelves = tables.length > 0 ? shelfLayout(tables.map((n) => n.file!.table!)) : null;
    // How much clear ground the section needs between the two repos: its own
    // width, the gutter its shelf names hang in, and the keep-out pad each
    // side. A corridor narrower than this can't hold it, and the repos would
    // spend the whole simulation being shoved out of a space their own anchors
    // keep pulling them back into.
    const corridor = shelves === null ? 0 : shelves.width + SHELF_NAME_GUTTER + SHELF_KEEP_OUT_PAD * 2;
    const anchorFor = (repoId: string): { x: number; y: number } => {
      const i = repoIds.indexOf(repoId);
      if (i === -1) return { x: this.width / 2, y: this.height / 2 }; // orbs: no repo pull
      // The resting spread, or wide enough for the section to stand between
      // them — whichever is bigger. With one repo there's no corridor to make.
      const spread = Math.max(
        Math.min(this.width, 900) * 0.36,
        repoIds.length > 1 ? corridor + SHELF_CORRIDOR_CLEAR : 0,
      );
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
      const memory = old ? undefined : recalled?.get(node.id);
      if (memory) recalledHits += 1;
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
        x: old?.x ?? memory?.x ?? seedX + (Math.random() - 0.5) * 60,
        y: old?.y ?? memory?.y ?? seedY + (Math.random() - 0.5) * 60,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
      };
      // Held where she put it — across a rebuild (she's still on the page) or
      // across a mount (from the memory). Pinning is d3's fx/fy: a node with
      // those set stays there and the physics flows around it.
      if (old && this.pinnedByHand.has(node.id)) {
        sn.fx = old.fx ?? old.x;
        sn.fy = old.fy ?? old.y;
      } else if (memory?.pinned) {
        this.pinnedByHand.add(node.id);
        sn.fx = memory.x;
        sn.fy = memory.y;
      }
      byId.set(sn.id, sn);
      return sn;
    });
    this.simLinks = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e): SimLink => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, kind: e.kind }));

    this.placeShelves(byId, repoIds, anchorFor, shelves);
    this.placeCoil(byId);

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

    // Which agents have touched which files, either direction — the tether
    // edges as a lookup, built here with the links for the same reason the
    // foreign keys are.
    this.sessionKin = new Map();
    for (const link of this.simLinks) {
      if (link.kind !== 'session') continue;
      const a = (link.source as SimNode).id;
      const b = (link.target as SimNode).id;
      if (!this.sessionKin.has(a)) this.sessionKin.set(a, new Set());
      if (!this.sessionKin.has(b)) this.sessionKin.set(b, new Set());
      this.sessionKin.get(a)!.add(b);
      this.sessionKin.get(b)!.add(a);
    }

    // The tree, as a child → parent lookup: what homeChain climbs to find the
    // folders a dot is kept in. Rebuilt here with the links, never in the draw
    // loop, and any hover already up is re-answered against it so a refeed
    // can't leave the wrong boxes lit.
    this.parentById = new Map(nodes.map((n) => [n.id, n.parentId]));
    if (this.hoverFile !== null || this.heldFile !== null) this.recomputeHoverKin();
    // ...and the spotlight's folders with it: a rebuild can collapse a chain
    // differently ("routes/kitchen"), which renames the very folders it lights.
    if (this.footprint !== null) this.footprintLit = this.withHomes(this.footprint);

    // Remember the shape we just laid out, so the next feed can be answered
    // without touching the sim. Built from what was HANDED IN, not from the
    // filtered simLinks — the next graph is compared against the same source,
    // and an edge dropped here for a missing endpoint would otherwise read as
    // a change forever.
    this.nodeIds = new Set(nodes.map((n) => n.id));
    this.edgeKeys = new Set(edges.map((e) => edgeKey(e.source, e.target)));

    this.refreshDerived(nodes);
    if (this.pinnedByHand.size > 0) this.onPins?.(this.pinnedByHand.size);

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
            // Rest the rope just beyond the two bodies, for the same reason
            // the tile gets its longer one: a rope shorter than the collision
            // circles it joins can never settle — the spring pulls in, the
            // collider throws back out. Ordinarily the two are already clear
            // of each other (34 is more than a pair of average dots need), so
            // this only lengthens for the widest bodies: two hot files wearing
            // rings, which is exactly where the strain would otherwise land.
            const rest = s.node.kind === 'repo' ? 70 : 34;
            return Math.max(rest, this.bodyRadiusOf(s) + this.bodyRadiusOf(t));
          })
          // Session tethers are weak on purpose: the orb drifts to sit amid
          // its territory without dragging the tree out of shape. The tile's
          // mooring is nearly as slack — a body this size should be HELD near
          // the cards hub, not sprung to it.
          .strength((l) =>
            l.kind === 'session'
              ? 0.06
              : // The coil's dots are pinned, so the folder rope may not pull
                // on them — and it's the one thing that could tear the spiral
                // apart, since every one of those hundred ropes hauls on the
                // same hub. The strand drawn through the coil says where they
                // live instead. Only the TREE rope is cut: a session tether
                // still pulls, which parks an agent's orb beside the photos
                // it opened, exactly as it does everywhere else.
                (l.kind ?? 'tree') === 'tree' &&
                  (this.onCoil(l.source as SimNode) || this.onCoil(l.target as SimNode))
                ? 0
                : // The shelves are pinned, so no spring may pull on them. A
                // link touching a table does nothing at all; the one rope
                // from the database's folder back into the vault is left
                // barely taut, or the pinned folder would drag `data/` and
                // everything under it across the map toward the shelves.
                l.kind === 'fk' || isTable(l.source as SimNode) || isTable(l.target as SimNode)
                ? 0
                : this.shelfHubIds.has((l.target as SimNode).id) ||
                    this.shelfHubIds.has((l.source as SimNode).id)
                  ? 0.01
                  : isPondTile(l.source as SimNode) || isPondTile(l.target as SimNode)
                    ? 0.15
                    : 0.7,
          ),
      )
      .force(
        'charge',
        forceManyBody<SimNode>().strength((n) =>
          // A coil dot pushes on nothing. It can't be pushed itself (it's
          // pinned), and a hundred of them repelling from inside one small
          // disc would blow the surrounding map outward far past the
          // clearing the coil actually needs — which its folder's collision
          // body already reserves, exactly once.
          this.onCoil(n)
            ? 0
            :
          // A table pushes harder than anything else on the map — about twice
          // a folder — so the ground around the shelves stays clear and the
          // vault's dots settle leaning away from them, not against them.
          isTable(n) ? -300 : n.node.kind === 'file' ? -38 : n.node.kind === 'session' ? -70 : -140,
        ),
      )
      // Nothing may enter a node's body — and for a file an agent is touching,
      // the body IS its ring (bodyRadius, ringBodies.ts). Collide separates
      // two nodes to at least the sum of their bodies, so a ring ends up
      // touching its neighbours at most and never lapping over them.
      .force('collide', forceCollide<SimNode>((n) => this.bodyRadiusOf(n)))
      // Keep the dots out of the table section. Charge and collision only
      // push a dot away from one table at a time, which lets it slip BETWEEN
      // two shelves and sit there; this treats the whole section as one
      // rectangle nothing else may rest inside. A dot found inside is pushed
      // out harder the deeper in it is, eased by the sim's cooling `alpha`
      // like every other force so the map still comes to rest. Agents' orbs
      // are left alone: they drift to wherever their files are and belong to
      // no territory.
      //
      // WHICH WAY OUT: through the side facing the dot's OWN repo. That one
      // rule does both jobs. With the section standing between the repos it
      // opens the corridor from both sides at once — the vault's dots part
      // leftward, the code's rightward — and neither repo is pushed through
      // the section into the other's territory. With the section out past the
      // edge of a lone repo it reduces to what it always did, since every dot
      // there has the same home and it lies to one side.
      //
      // The zone is wider on the LEFT by the shelf names' gutter: they are
      // right-aligned to end just before each shelf, and a dot resting under
      // them makes them unreadable.
      .force('shelfKeepOut', (alpha: number) => {
        const shelf = this.shelf;
        if (!shelf || shelf.left === null || shelf.top === null) return;
        const zoneLeft = shelf.left - SHELF_KEEP_OUT_PAD - SHELF_NAME_GUTTER;
        const zoneRight = shelf.left + shelf.layout.width + SHELF_KEEP_OUT_PAD;
        const zoneTop = shelf.top - SHELF_KEEP_OUT_PAD;
        const zoneBottom = shelf.top + shelf.layout.height + SHELF_KEEP_OUT_PAD;
        const zoneMiddle = (zoneLeft + zoneRight) / 2;
        for (const n of this.simNodes) {
          if (isTable(n) || this.shelfHubIds.has(n.id) || n.node.kind === 'session') continue;
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          if (x < zoneLeft || x > zoneRight || y < zoneTop || y > zoneBottom) continue;
          if (anchorFor(n.node.repoId).x <= zoneMiddle) {
            n.vx = (n.vx ?? 0) - (x - zoneLeft) * SHELF_KEEP_OUT_PUSH * alpha;
          } else {
            n.vx = (n.vx ?? 0) + (zoneRight - x) * SHELF_KEEP_OUT_PUSH * alpha;
          }
        }
      })
      .force('x', forceX<SimNode>((n) => anchorFor(n.node.repoId).x).strength((n) => (n.node.kind === 'session' ? 0 : 0.045)))
      .force('y', forceY<SimNode>((n) => anchorFor(n.node.repoId).y).strength((n) => (n.node.kind === 'session' ? 0 : 0.055)))
      // A map restored from memory is already settled: it gets the faintest
      // warmth, enough to place whatever is new and no more. A rebuild while
      // she watches re-warms at 0.35; only a map with no past explodes from 1.
      .alpha(recalled !== null && recalledHits >= nodes.length * 0.6 ? 0.06 : prev.size > 0 ? 0.35 : 1)
      .on('tick', () => {
        // Ballast. d3-force has no mass — every node coasts equally — so the
        // tile, the biggest body on the map, was being carried by every wave
        // that passed through the crowd. Bleeding most of its velocity each
        // tick makes it move like the heavy thing it is: nudges still land,
        // drift doesn't.
        for (const sn of this.simNodes) {
          // Ballast, for the same reason the tile gets it: the coil's folder
          // is now one of the biggest bodies on the map, and d3 has no mass,
          // so without this it gets carried by every wave passing through the
          // crowd — towing a hundred pinned dots behind it.
          if (!isPondTile(sn) && sn.id !== this.coil?.hub.id) continue;
          sn.vx = (sn.vx ?? 0) * 0.3;
          sn.vy = (sn.vy ?? 0) * 0.3;
        }
        // The coil rides its hub, and pays its new dots out toward their
        // spots. Every tick, not on the shelves' slower cadence: the hub
        // moves every tick and the dots have to move with it.
        this.settleCoil(COIL_EASE);
        // Keep the table shelves just outside the dots as the dots spread.
        this.ticksSinceLayout += 1;
        if (this.ticksSinceLayout % SHELF_SETTLE_EVERY === 0) this.settleShelves(0.25);
        this.requestDraw();
      })
      // Quiescence = sleep. d3-force stops its own timer at alphaMin; one
      // final paint and nothing runs until the next setGraph.
      .on('end', () => {
        // One last measure, so the shelves rest exactly clear of where the
        // dots finally stopped; then the once-only re-frame that includes
        // them, if it was asked for and the camera is still ours to move.
        this.settleShelves(1);
        // ...and the coil snaps the rest of the way in. A sim that goes still
        // mid-glide would leave the chain half paid out, frozen, with nothing
        // left running to finish it.
        this.settleCoil(1);
        // Quiescence is the natural moment to write the map down: this is the
        // arrangement she'd want back.
        this.saveLayout();
        if (this.refitWhenSettled) {
          this.refitWhenSettled = false;
          if (!this.cameraIsHers) this.fitSoon();
        }
        this.requestDraw();
      });
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
      // Never yank a camera she placed — including one restored from the last
      // time she had this page open (layoutMemory.ts).
      if (this.cameraIsHers) return;
      // A focused surface frames its agent's cluster instead — don't yank the
      // camera out to the whole graph once the orb exists to home in on.
      if (this.focusConv && this.computeFocusTransform()) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of this.simNodes) {
        // A dot is framed by its centre; a table by its whole rectangle, or a
        // tall one at the edge of the map gets framed with its top cut off.
        const size = n.node.file?.table ? tableSize(n.node.file.table) : null;
        const halfW = size ? size.width / 2 : 0;
        const halfH = size ? size.height / 2 : 0;
        minX = Math.min(minX, (n.x ?? 0) - halfW);
        maxX = Math.max(maxX, (n.x ?? 0) + halfW);
        minY = Math.min(minY, (n.y ?? 0) - halfH);
        maxY = Math.max(maxY, (n.y ?? 0) + halfH);
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
      if (!this.isTouchable(n)) continue; // ...nor can scenery, outside a selection
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
    // Swallow the click a finished drag fires: she moved a dot, she didn't ask
    // to open it.
    if (performance.now() - this.draggedAt < DRAG_CLICK_GRACE_MS) return;
    this.onTap?.(this.nodeAt(ev)?.node ?? null);
  };

  /**
   * Can she pick this one up? Everything the physics places is fair game. The
   * tables are not: they stand on shelves the engine re-measures as the dots
   * spread (placeShelves), so a hand-placed table would be shoved straight back
   * on the next settle — a press on one pans the map, exactly as it always did.
   */
  private canDrag(node: SimNode | null): node is SimNode {
    if (!node) return false;
    // A coil dot is pinned to its spot on the spiral and would be shoved
    // straight back on the next tick, exactly like a table on its shelf. The
    // coil's FOLDER is draggable, though, and the whole spiral rides it.
    return !isTable(node) && !this.shelfHubIds.has(node.id) && !this.onCoil(node);
  }

  /**
   * Pick a node up. Nothing here runs unless the press landed on something
   * draggable — the zoom filter asked the same question first and only stood
   * down if the answer was yes. Capturing the pointer keeps the drag alive when
   * the cursor leaves the canvas, and warming the sim a little lets the
   * neighbours make room as she moves it.
   *
   * Prompt that produced it: "i also want to be able to drag nodes around and
   * for it to save that position until i refresh the page."
   */
  private handlePointerDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (this.dragNode !== null) return; // one node at a time; a second finger is a pinch
    const hit = this.nodeAt(ev);
    if (!this.canDrag(hit)) return;
    this.dragNode = hit;
    this.dragPointerId = ev.pointerId;
    this.dragMoved = false;
    hit.fx = hit.x;
    hit.fy = hit.y;
    this.canvas.setPointerCapture(ev.pointerId);
    this.canvas.style.cursor = 'grabbing';
    this.sim?.alphaTarget(DRAG_ALPHA).restart();
  };

  /** The node follows the pointer in WORLD coordinates, so it stays under her
   * finger at any zoom. */
  private dragTo(ev: PointerEvent): void {
    const node = this.dragNode;
    if (!node) return;
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.transform.invert([ev.clientX - rect.left, ev.clientY - rect.top]);
    node.fx = wx;
    node.fy = wy;
    node.x = wx;
    node.y = wy;
    this.dragMoved = true;
    this.requestDraw();
  }

  /**
   * Put it down — and leave it there. The node keeps its fx/fy, which is what
   * "it stays where I put it" means in a force layout: the physics flows around
   * it instead of reclaiming it, until she releases it or reloads the page. A
   * press that never moved was a tap, so that one hands the node back (unless
   * it was already pinned) and lets the click through.
   */
  private handlePointerUp = (ev: PointerEvent): void => {
    const node = this.dragNode;
    if (node === null || ev.pointerId !== this.dragPointerId) return;
    this.dragNode = null;
    this.dragPointerId = null;
    if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    this.canvas.style.cursor = '';
    this.sim?.alphaTarget(0);
    if (this.dragMoved) {
      this.pinnedByHand.add(node.id);
      this.onPins?.(this.pinnedByHand.size);
      this.draggedAt = performance.now();
      this.saveLayout(true);
    } else if (!this.pinnedByHand.has(node.id)) {
      node.fx = null;
      node.fy = null;
    }
    this.dragMoved = false;
    this.requestDraw();
  };

  /**
   * Hand the map back to the physics: every hand-placed node is released and
   * the sim is warmed just enough for them to rejoin the crowd. The resting
   * positions are left alone, so the map settles from where it is rather than
   * jumping.
   */
  releasePins(): void {
    if (this.pinnedByHand.size === 0) return;
    for (const sn of this.simNodes) {
      if (!this.pinnedByHand.has(sn.id)) continue;
      sn.fx = null;
      sn.fy = null;
    }
    this.pinnedByHand.clear();
    forgetPins();
    this.onPins?.(0);
    this.sim?.alpha(0.2).restart();
  }

  /**
   * Hover: which agent is under the cursor. Mouse-only — a touch pointer fires
   * this too, and honouring it would leave a phone lit up for an agent she
   * merely tapped past, with no "move the cursor away" available to undo it.
   * Nothing here wakes the sim; a changed hover costs exactly one repaint.
   */
  private handlePointerMove = (ev: PointerEvent): void => {
    // Carrying a node: the gesture is the drag and nothing else — no hover, and
    // no camera, which stood down back at pointerdown.
    if (this.dragNode !== null && ev.pointerId === this.dragPointerId) {
      this.dragTo(ev);
      return;
    }
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
    // ...and names itself, wired or not. Every file, not just the wired ones:
    // "what is this dot" is the question a stranger to the map asks first, and
    // the answer shouldn't depend on whether anything happens to be joined to
    // it.
    this.setHoverLabel(any?.node.kind === 'file' ? any.id : null);
    this.reportHover(hit);
  };

  private handlePointerLeave = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'mouse') return;
    this.canvas.style.cursor = '';
    this.setHoverAgent(null);
    this.setHoverFile(null);
    this.setHoverLabel(null);
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
  /**
   * Hand the engine the coil: the upload dots in order, innermost first, and
   * the folder node they wind around.
   *
   * Order is the geometry — spot 0 is the centre of the spiral — so this is
   * an array and not a set, unlike setPondNodes above. Pass an empty list to
   * take the coil off the map and let those dots go back to being ordinary
   * children of their folder.
   */
  setCoilNodes(ids: readonly string[], folderId: string | null, caption: string | null): void {
    this.coilCaption = caption;
    const same =
      folderId === this.coilFolderId &&
      ids.length === this.coilIds.length &&
      ids.every((id, i) => id === this.coilIds[i]);
    if (same) return;
    this.coilIds = ids;
    this.coilFolderId = folderId;
    // Wind it now rather than waiting for the next setGraph. The page hands
    // the coil over and builds the graph in two separate effects, and their
    // order isn't ours to rely on: on the first payload this arrives second
    // as often as first, and a coil that waited would leave the uploads
    // sprayed across the map until something else happened to rebuild.
    if (this.simNodes.length === 0) return;
    this.placeCoil(new Map(this.simNodes.map((n) => [n.id, n])));
    // The folder just grew a body the size of the whole spiral (or lost one),
    // and d3 caches collision radii in initialize() — so the forces have to
    // be told, or the map would go on treating the centre as a plain folder
    // and thread itself straight through the arms.
    this.reshapeBodies();
  }

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
   * Stand the tables on their shelves, in a section of their own in the
   * CORRIDOR BETWEEN the repos — between her vault and the app code.
   *
   * That is where the database actually belongs in the story the map tells:
   * exo.db holds the vault's data and is written entirely by the app's code,
   * so it is the seam between the two, not an outbuilding past the edge of
   * one of them. It also shortens every rope the table hover draws: those run
   * from a table to the CODE files that touch it, and from the vault's far
   * edge each one had to cross the whole vault and then the gap.
   *
   * With only one repo on the map there is no corridor, and the section falls
   * back to standing past that repo's outer edge (`between: false`).
   *
   * The arrangement itself is tableNodes.ts shelfLayout (families of joined
   * tables, one per shelf, all on a shared baseline); this only works out
   * where the section goes and remembers the pieces. settleShelves then
   * measures the spot and pins the tables to it.
   *
   * Prompt that produced it: "i would like for the sql databases to be
   * positioned centrally between the personal and the code database rather
   * than being on the right edge".
   */
  private placeShelves(
    byId: ReadonlyMap<string, SimNode>,
    repoIds: readonly string[],
    anchorFor: (repoId: string) => { x: number; y: number },
    /** The section's arrangement, already worked out by setGraph — which had
     * to know its width to space the repos far enough apart for it. */
    layout: ShelfLayout | null,
  ): void {
    const before = this.shelf;
    this.shelf = null;
    this.shelfHubIds = new Set();
    const tables = this.simNodes.filter(isTable);
    if (tables.length === 0 || layout === null) return;

    const repoId = tables[0].node.repoId;
    // Outward = away from the average of the OTHER repos' anchors. With only
    // one repo on the map there is no "other side", so the right will do.
    const others = repoIds.filter((id) => id !== repoId).map((id) => anchorFor(id).x);
    const othersX = others.length > 0 ? others.reduce((sum, x) => sum + x, 0) / others.length : -Infinity;
    const hubs: SimNode[] = [];
    for (const n of tables) {
      const hub = n.node.parentId ? byId.get(n.node.parentId) : undefined;
      if (hub && !this.shelfHubIds.has(hub.id)) {
        this.shelfHubIds.add(hub.id);
        hubs.push(hub);
      }
    }
    this.shelf = {
      layout,
      repoId,
      outward: anchorFor(repoId).x >= othersX ? 1 : -1,
      between: others.length > 0,
      tables,
      hubs,
      // Start from where the section already was, so a refetch that changes
      // nothing about the dots doesn't make the shelves jump.
      left: before?.left ?? null,
      top: before?.top ?? null,
    };
    this.settleShelves(1);
    // The first time the shelves appear, ask for the map to be framed again
    // once the physics comes to rest (the sim's 'end' handler does it). The
    // tables arrive in their own request, usually just after the camera has
    // already framed a map that didn't have them, and they keep gliding
    // outward for as long as the dots keep spreading — so any earlier moment
    // frames a section that then walks off the edge of the screen.
    if (before === null && !this.ambient) this.refitWhenSettled = true;
  }

  /**
   * Put the shelves in the corridor between the two repos, and pin every table
   * to its spot there.
   *
   * Measured, not assumed: the physics only LEANS a repo toward its anchor, so
   * where each cluster of dots ends up — and how big it is, at 300 files or at
   * 3,000 — can't be known ahead of time. So this looks at where the dots
   * actually are. Two measurements, one per side: how far the database's own
   * repo reaches TOWARD the other, and how near the other comes back. The
   * section is centred between those two facing edges, which is what "between
   * them" means on a map whose two halves are different sizes — the midpoint
   * of the anchors would sit inside the bigger cluster.
   *
   * The clusters usually overlap that corridor at first, and nothing here
   * moves them: the 'shelfKeepOut' force does, pushing each dot out through
   * the side facing its OWN repo, so the corridor opens from both sides as
   * the map settles rather than the section shoving its way in.
   *
   * With one repo (`between: false`) there is nothing to be between, and the
   * old rule stands: SHELF_MARGIN past the outer edge of that repo's dots.
   *
   * `ease` is how much of the way to move toward the measured spot: 1 snaps
   * (first placement), a fraction glides (called every few ticks while the map
   * is still settling, so the section drifts out with the dots instead of
   * being overrun by them and then jumping).
   *
   * Pinning is d3's `fx`/`fy`: a node with those set is held at that spot and
   * the physics moves everything else around it. The database's folder node is
   * pinned at the section's top corner as its heading; one slack rope still
   * runs from it back to `data/`, which is what says the section is the
   * vault's.
   */
  private settleShelves(ease: number): void {
    const shelf = this.shelf;
    if (!shelf) return;
    // Measure both sides at once, in "toward the other repo" space: `inward`
    // flips the axis so that bigger always means further along that way,
    // whichever side of the map the database's repo happens to be on.
    const inward: 1 | -1 = shelf.outward > 0 ? -1 : 1;
    let ownInner = -Infinity;    // how far the database's repo comes this way
    let ownOuter = -Infinity;    // ...and how far it reaches the other way
    let otherInner = Infinity;   // how near the other repo comes back
    let sumY = 0;
    let ownCounted = 0;
    for (const n of this.simNodes) {
      if (isTable(n) || this.shelfHubIds.has(n.id) || n.node.kind === 'session') continue;
      if (!n.node.repoId) continue;
      const along = (n.x ?? 0) * inward;
      if (n.node.repoId === shelf.repoId) {
        ownInner = Math.max(ownInner, along + n.radius);
        ownOuter = Math.max(ownOuter, -along + n.radius);
        sumY += n.y ?? 0;
        ownCounted += 1;
      } else {
        otherInner = Math.min(otherInner, along - n.radius);
      }
    }
    if (ownCounted === 0) return;

    let targetLeft: number;
    if (shelf.between && otherInner !== Infinity) {
      targetLeft = corridorLeft(ownInner, otherInner, inward, shelf.layout.width);
    } else {
      // One repo, nothing to be between: stand clear of its outer edge.
      const nearSide = ownOuter + SHELF_MARGIN;
      targetLeft = shelf.outward > 0 ? nearSide : -nearSide - shelf.layout.width;
    }
    // Vertically centred on the database's own repo either way — the section
    // belongs to the vault, and centring on the whole map would let it drift
    // with whichever side happens to have more files.
    const targetTop = sumY / ownCounted - shelf.layout.height / 2;
    const left = shelf.left === null ? targetLeft : shelf.left + (targetLeft - shelf.left) * ease;
    const top = shelf.top === null ? targetTop : shelf.top + (targetTop - shelf.top) * ease;
    shelf.left = left;
    shelf.top = top;

    for (const n of shelf.tables) {
      const spot = shelf.layout.positions.get(n.node.file!.table!.name);
      if (!spot) continue;
      n.fx = n.x = left + spot.x;
      n.fy = n.y = top + spot.y;
    }
    for (const hub of shelf.hubs) {
      hub.fx = hub.x = left;
      hub.fy = hub.y = top - 8;
    }
  }

  /**
   * Resolve the coil the page asked for into real nodes, and work out its
   * shape.
   *
   * Runs once per setGraph, with the nodes freshly built — never per tick.
   * The arrangement only depends on HOW MANY dots there are, and that can
   * only change when the graph does.
   *
   * A dot already on the coil keeps the offset it had, so a rebuild that
   * changes nothing (a heat tick, a refetch) doesn't make the coil jump. A
   * dot that is NEW to it starts at the centre, which is what pays the chain
   * out when she widens the window.
   */
  private placeCoil(byId: ReadonlyMap<string, SimNode>): void {
    const before = this.coil;
    this.coil = null;
    this.coilDotIds = new Set();
    const hub = this.coilFolderId ? byId.get(this.coilFolderId) : undefined;
    if (!hub || this.coilIds.length === 0) return;
    const dots = this.coilIds.map((id) => byId.get(id)).filter((n): n is SimNode => n !== undefined);
    if (dots.length === 0) return;

    const arrangement = spiralSpots(dots.length);
    const held = new Map(before?.dots.map((dot, i) => [dot.id, before.offsets[i]]) ?? []);
    const offsets = dots.map((dot) => held.get(dot.id) ?? { x: 0, y: 0 });
    this.coil = { hub, dots, arrangement, offsets };
    this.coilDotIds = new Set(dots.map((dot) => dot.id));
    // One settle at full strength so the FIRST frame has the coil already
    // wound rather than collapsed into its own centre. Only dots carried over
    // from a previous coil have an offset to keep; the new ones are at the
    // centre and this pass is what starts them moving.
    this.settleCoil(before === null ? 1 : COIL_EASE);
  }

  /**
   * Pin every upload dot to its spot on the coil, and ease the new ones out
   * along the strand toward theirs.
   *
   * Called every tick, because the hub moves every tick: the offsets are what
   * ease, and the hub's own position is followed exactly. Doing it the other
   * way — easing the absolute position toward hub + spot — smears the coil
   * behind the hub whenever the map shifts it.
   */
  private settleCoil(ease: number): void {
    const coil = this.coil;
    if (coil === null) return;
    const hubX = coil.hub.x ?? 0;
    const hubY = coil.hub.y ?? 0;
    for (let i = 0; i < coil.dots.length; i += 1) {
      const dot = coil.dots[i];
      const spot = coil.arrangement.spots[i];
      const offset = coil.offsets[i];
      offset.x += (spot.x - offset.x) * ease;
      offset.y += (spot.y - offset.y) * ease;
      // Pinned, exactly like a table on its shelf: fx/fy hold the dot in
      // place and the physics flows around it. The velocity goes with it, or
      // the sim keeps integrating a node that isn't allowed to move and the
      // map never reaches quiescence — it would spin its timer forever.
      dot.fx = dot.x = hubX + offset.x;
      dot.fy = dot.y = hubY + offset.y;
      dot.vx = 0;
      dot.vy = 0;
    }
  }

  /**
   * Draw the strand: one line running the length of the coil, newest dot to
   * oldest.
   *
   * This is the coil's only line, and it replaces a hundred of them — the
   * folder ropes are skipped for these dots (see the paint loop), because a
   * fan out of the centre would fill the spiral solid and say nothing except
   * "these are in that folder", which standing on the coil already says.
   *
   * The strand says something the fan couldn't: it's the ORDER. Following it
   * out from the middle is walking backwards through her uploads, and the
   * gaps in it are the weeks she didn't upload anything.
   *
   * Drawn under the dots, in the map's plain border grey, and fading toward
   * the tip so the coil reads as trailing off into the past rather than
   * stopping dead at whatever the window happens to cut.
   */
  private drawCoilStrand(
    ctx: CanvasRenderingContext2D,
    transform: ZoomTransform,
    theme: ThemeInk,
    dimmed: boolean,
  ): void {
    const coil = this.coil;
    if (coil === null || coil.dots.length < 2) return;
    // Hidden dots (the Files dial cut below them, the vault toggled off) take
    // the strand with them — a line running through empty ground would be a
    // claim about dots that aren't on the map.
    if (this.hiddenFiles.has(coil.dots[0].id)) return;

    ctx.save();
    ctx.lineWidth = 1 / transform.k;
    ctx.strokeStyle = theme.border;
    ctx.setLineDash([]);
    // One segment at a time rather than one long path, because each fades a
    // little further than the last and a single stroke can only hold one
    // alpha. The coil is a few hundred segments at most — the same order as
    // the tree edges drawn just above.
    for (let i = 1; i < coil.dots.length; i += 1) {
      const from = coil.dots[i - 1];
      const to = coil.dots[i];
      if (this.hiddenFiles.has(to.id)) break;
      const along = i / coil.dots.length;
      ctx.globalAlpha = (dimmed ? 0.12 : 0.4) * (1 - along * 0.75);
      ctx.beginPath();
      ctx.moveTo(from.x ?? 0, from.y ?? 0);
      ctx.lineTo(to.x ?? 0, to.y ?? 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Is this dot wound onto the upload coil? Pinned, so the springs and the
   * charge must leave it alone, and the tree edge into it isn't drawn — the
   * strand through the coil says where it lives far better than a hundred
   * lines fanning out of one folder could. */
  private onCoil(n: SimNode): boolean {
    return this.coilDotIds.has(n.id);
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
   * Opaque on purpose: lines are painted before bodies, so a solid table
   * hides anything that happens to pass behind it instead of looking crossed
   * out. Neutral ink, not heat — a table has no edit history on this map, and
   * wearing the ramp's cold black would claim it's an old file.
   */
  /**
   * Where a line coming from (fromX, fromY) should meet a table: the point on
   * its drawn rectangle's edge facing that way.
   *
   * The rectangle is centred on the node and painted opaque, so a line aimed
   * at the centre would disappear under it. Walking out from the centre toward
   * the caller and stopping at whichever side is reached first gives the edge
   * point; the walk is never longer than the half-box (`Math.min(1, …)`), so a
   * dot sitting INSIDE the rectangle gets the centre rather than a point past
   * the far side. Same minimum screen size as drawTable, so the two agree at
   * every zoom.
   */
  private tableEdgeToward(n: SimNode, fromX: number, fromY: number): [number, number] {
    const table = n.node.file?.table;
    const cx = n.x ?? 0;
    const cy = n.y ?? 0;
    if (!table) return [cx, cy];
    const floor = TABLE_MIN_PX / this.transform.k;
    const size = tableSize(table);
    const halfWidth = Math.max(size.width, floor) / 2;
    const halfHeight = Math.max(size.height, floor) / 2;
    const dx = fromX - cx;
    const dy = fromY - cy;
    const reach = Math.min(
      1,
      Math.min(halfWidth / (Math.abs(dx) || 1e-6), halfHeight / (Math.abs(dy) || 1e-6)),
    );
    return [cx + dx * reach, cy + dy * reach];
  }

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

  /**
   * How much of its presence a line keeps, given the dots at its two ends.
   * Only "Types" has a stale fade to follow, so off it this is always 1 and
   * nothing about the lines changes. A line is only ever as present as the
   * stalest plain file it touches — the dot that faded furthest is the one
   * the line has to agree with. Ends that aren't plain file dots (folders,
   * repos, orbs, the pond, the table shelves) have no staleness of their own
   * and are skipped; a line between two of them stays at full strength.
   */
  private staleEdgeAlpha(a: SimNode, b: SimNode): number {
    if (!this.typeColors) return 1;
    let alpha = 1;
    for (const n of [a, b]) {
      // A folder end takes the folder's own fade, and takes it ALL the way
      // down — no half-presence floor. The floor exists so a line can still
      // say "a file is there" after its dot has gone; once the whole branch
      // is out there's nothing left for the line to say, and a half-lit line
      // to a folder that isn't painted is a limb hanging in the air.
      if (n.node.kind === 'dir' || n.node.kind === 'repo') {
        alpha = Math.min(alpha, this.folderFadeOf(n.id));
        continue;
      }
      if (n.node.kind !== 'file' || !n.node.file || n.node.file.days || isTable(n)) continue;
      alpha = Math.min(alpha, staleTypeAlpha(n.t, n.a));
    }
    return alpha;
  }

  /**
   * How this folder's outline is split under "Types" — its file types as
   * coloured shares of the border, commonest first. Undefined when nothing
   * visible is inside it, which the caller reads as "leave it plain".
   *
   * A cache that rebuilds when its answer could have changed: a new graph, a
   * new surface, or a different hidden set (see folderShareCache). Building
   * it walks every file's parent chain once, which is cheap — but not cheap
   * enough to want on every frame of the breath, hence the identity test.
   */
  private folderSharesOf(id: string): { color: string; fraction: number }[] | undefined {
    this.ensureFolderLens();
    return this.folderShareCache!.get(id);
  }

  /**
   * How present this folder is, 0..1 — the aliveness of the liveliest file
   * beneath it, or 0 when there's nothing live down there at all. Only
   * "Types" fades a folder, so off it every folder is fully present.
   *
   * A folder is exactly as present as the most alive thing inside it. That's
   * what keeps the structure honest once stale files start disappearing: a
   * full outline around a subtree of faded dots is a box drawn around
   * nothing, and worse, it reads as "something is here".
   *
   * Prompt that produced it: "i want the folder node to be hidden / the
   * background color if there are no files highlighted within its tree".
   */
  private folderFadeOf(id: string): number {
    if (!this.typeColors) return 1;
    this.ensureFolderLens();
    return this.folderFadeCache.get(id) ?? 0;
  }

  /** Rebuild the folder lens if anything it's built from has moved. */
  private ensureFolderLens(): void {
    if (this.folderShareCache === null || this.folderSharesKey !== this.hiddenFiles) {
      const built = new Map<string, { color: string; fraction: number }[]>();
      const nodes = this.simNodes.map((sn) => sn.node);
      const ranked = childTypeCounts(nodes, this.hiddenFiles);
      // How alive each folder's liveliest file is. Read off the sim, where
      // both heats are already normalised for the window the Heat bar is on,
      // then put through glowAlpha — the same curve a file dot fades out on,
      // so a folder goes dark at the moment its last live file does.
      const glowById = new Map(this.simNodes.map((sn) => [sn.id, glowOf(sn.t, sn.a)]));
      this.folderFadeCache = new Map();
      for (const [folderId, alive] of liveliestBeneath(
        nodes,
        this.hiddenFiles,
        (node) => glowById.get(node.id) ?? 0,
      )) {
        this.folderFadeCache.set(folderId, glowAlpha(alive));
      }
      for (const [folderId, types] of ranked) {
        const total = types.reduce((sum, share) => sum + share.count, 0);
        if (total === 0) continue;
        // Keep the types worth seeing and lump the tail into one neutral
        // slice. A segment thinner than a few pixels reads as a nick in the
        // outline rather than as a colour, so a folder with one file of each
        // of nine languages would be a ring of noise — the tail says "and
        // some other things" in the plain border colour instead.
        const shares: { color: string; fraction: number }[] = [];
        let kept = 0;
        for (const share of types) {
          const fraction = share.count / total;
          if (shares.length > 0 && (fraction < MIN_FOLDER_SHARE || shares.length >= MAX_FOLDER_SHARES)) break;
          shares.push({
            color: typeDotColor(share.type.color, this.theme.bg, this.theme.text),
            fraction,
          });
          kept += fraction;
        }
        if (1 - kept > 0.001) shares.push({ color: this.theme.border, fraction: 1 - kept });
        built.set(folderId, shares);
      }
      this.folderShareCache = built;
      this.folderSharesKey = this.hiddenFiles;
    }
  }

  /**
   * The colour a file dot is wearing right now, resolved to one hex.
   *
   * Three lenses can decide it, in the order the dot itself is painted: the
   * Types toggle first, then the 24h created-green, then the heat ramps. On
   * the dark surface the dot is laid down as two layers — an ash disc with
   * its hue over it at glow opacity — and this is what those two come to, so
   * a line drawn in it agrees with the dot it leaves.
   *
   * Used by the tree edges: the chain of folders a hovered file is kept in is
   * drawn in that file's own colour, so the line she follows up the tree
   * belongs visibly to THAT dot.
   *
   * Prompt that produced it: "the line between the file and its folders could
   * be colored with whatever color is displayed currently in the dot, to be
   * able to see more easily where it goes to".
   */
  private fileDotInk(
    n: SimNode,
    ramp: readonly string[],
    goldRamp: readonly string[],
    nowSeconds: number,
    forChain = false,
  ): string {
    const { theme } = this;
    if (this.typeColors) {
      const path = n.node.path ?? n.node.label;
      let typeColor = this.typeColorCache.get(path);
      if (typeColor === undefined) {
        typeColor = typeDotColor(fileTypeOf(path).color, theme.bg, theme.text);
        this.typeColorCache.set(path, typeColor);
      }
      return staleTypeColor(typeColor, theme.bg, n.t, n.a);
    }
    if (n.node.file && fileCreatedWithin(n.node.file, CREATED_FRESH_WINDOW_SECONDS, nowSeconds)) {
      return CREATED_GREEN;
    }
    // A CHAIN line takes the same heat colour the dot does, with two
    // adjustments the dot itself never gets: it stops short of gold, which is
    // already the threads' ink (chainLean), and it is floored so a stale
    // file's home is still followable (chainGlow). Both say why in
    // hoverLayers.ts. The dot's own colour is untouched either way.
    const lean = forChain ? chainLean(leanOf(n.t, n.a)) : leanOf(n.t, n.a);
    const glow = forChain ? chainGlow(glowOf(n.t, n.a)) : glowOf(n.t, n.a);
    if (theme.dark) {
      return mixHex(theme.ash, mixHex(EMBER_HOT, GOLD_HOT, lean), glowAlpha(glow));
    }
    // Light keeps its legacy priority rule for DOTS — anything that ran paints
    // the gold ramp over its red history. A chain can't use that rule at all,
    // because the gold end of it is the threads', so it reads the ember ramp
    // at the union of both heats instead.
    if (forChain) return heatColor(glow, ramp);
    return n.a > 0 ? heatColor(n.a, goldRamp) : heatColor(n.t, ramp);
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
      // The selection's own threads (hoverLayers.ts). A thread with either end
      // inside what she picked out belongs to that answer, and a hover over one
      // of its files must not take it away — it stays at exactly the presence
      // it had before the cursor arrived.
      //
      // Prompt that produced it: "when one agent or sql feature is selected,
      // the threads connecting that file don't disappear when hovering over
      // another file … i am ok with both showing".
      const picked = this.selectionAnswer();
      for (const th of this.threads) {
        const mine = held !== null && (th.sourceId === held || th.targetId === held);
        const ofSelection =
          picked !== null && (picked.has(th.sourceId) || picked.has(th.targetId));
        // Which threads are worth drawing, in three tiers (threadTooCold).
        // A cold thread nobody asked about is skipped as invisible. The
        // HOVERED file's own threads are drawn however cold they are — the
        // question being asked is "what is this wired to", and a pipe that
        // hasn't moved in a month is still a pipe. The SELECTION's threads
        // keep the floor they had before the hover, so narrowing onto one of
        // its files neither adds threads nor removes any. Cold ones stay
        // legibly cold — the floor below lifts them into view, it doesn't
        // repaint them as fresh.
        if (threadTooCold(th.t, mine, ofSelection, held !== null)) continue;
        const a = byId.get(th.sourceId);
        const b = byId.get(th.targetId);
        if (!a || !b) continue; // one end filtered off the map by a dial
        if (this.hiddenFiles.has(a.id) || this.hiddenFiles.has(b.id)) continue; // or outside the date range
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
        // Hovering a file asks a SECOND question without cancelling the
        // first: its own threads go to full opacity with a colour floor that
        // guarantees a cold one is actually visible, the picked-out
        // selection's threads hold exactly where they were, and only the
        // threads neither answer named drop to a trace (threadPresence).
        const lit = held === null ? th.t : mine ? Math.max(th.t, 0.42) : th.t;
        ctx.globalAlpha = threadPresence(th.t, mine, ofSelection, held !== null);
        ctx.strokeStyle = heatColor(lit, goldRamp);
        ctx.lineWidth = (0.6 + 1.5 * lit) / transform.k * (mine ? 1.6 : 1);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(mx - (dy / len) * bow, my + (dx / len) * bow, bx, by);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // -- table-to-code ropes: which files touch the hovered table --
    //
    // Only under a hover, and only the ropes the two live answers own. Every
    // rope at once would be a solid mat: thirty-odd tables against the files
    // that touch them is hundreds of lines across the whole map, and the map's
    // subject is the files, not the database. So this answers the question
    // asked — "what code touches THIS table" — in both directions, since
    // hovering one of those files draws the same ropes back to the tables it
    // touches.
    //
    // With a table PINNED, that is TWO answers at once: the pinned table keeps
    // its ropes out to all of its files, and the file under the cursor draws
    // its own ropes on top at full strength. Narrowing onto a member of a
    // selection asks a second question; it doesn't withdraw the first.
    //
    // Blue, the same ink the foreign keys wear, because both lines are about
    // the database; gold is a write passing between files and the accent is
    // the agents'. What the file DOES sets the weight: creating is heavier
    // than writing, writing than reading. The dot marks the TABLE end — the
    // thing being acted on — the same way an fk's dot marks the table its key
    // points at.
    //
    // Bowed, for the reason the threads are: a rope between two dots that
    // happen to sit near each other vanishes under them, and several ropes
    // leaving one table for the same corner of the map would stack into one
    // smear.
    if (this.hoverFile !== null && this.tableCodeLinks.length > 0) {
      const held = this.hoverFile;
      // Two tones, once a table is PINNED. The rope running back to the pinned
      // table keeps the database blue; the ropes on to the OTHER tables this
      // file touches are drawn a shade greyer, so "this is the table I picked"
      // and "these are the others it's wired to" don't read as one answer.
      // Same hue either way — both lines are still about the database — and
      // with nothing pinned every rope is the plain blue it always was.
      //
      // Prompt that produced it: "the color of the lines that go from the file
      // to the other sql tables should be a slightly different color".
      const pinnedTable = this.heldFile;
      const otherTableInk = mixHex(theme.evening, theme.textMuted, 0.5);
      // The two bodies whose ropes are drawn: the one under the cursor, and
      // the pinned table she narrowed away from. They're the same body until
      // she moves onto one of its files, at which point the pin keeps its own.
      const pinKin = pinnedTable !== null ? this.codeLinkKin.get(pinnedTable) : undefined;
      const kin = this.codeLinkKin.get(held);
      if ((kin !== undefined && kin.size > 0) || (pinKin !== undefined && pinKin.size > 0)) {
        // One pass for the handful of nodes involved — the two subjects and
        // whatever is at the other end of their ropes. Cheaper than a map of
        // every node on the map, which this would otherwise rebuild on every
        // frame the breath draws while she holds a hover.
        const ends = new Map<string, SimNode>();
        for (const n of this.simNodes) {
          if (
            n.id === held ||
            n.id === pinnedTable ||
            kin?.has(n.id) === true ||
            pinKin?.has(n.id) === true
          ) {
            ends.set(n.id, n);
          }
        }
        ctx.setLineDash([]);
        for (const link of this.tableCodeLinks) {
          // Whose rope is this? The hovered body's ropes are the front answer;
          // the pinned table's remaining ropes are the standing one behind it.
          // A rope that is both reads as the hovered one, which is why the
          // hover test comes first.
          const ofHover = link.tableId === held || link.fileId === held;
          const ofPin = pinnedTable !== null && link.tableId === pinnedTable;
          if (!ofHover && !ofPin) continue;
          const tableNode = ends.get(link.tableId);
          const fileNode = ends.get(link.fileId);
          if (!tableNode || !fileNode) continue;
          if (this.hiddenFiles.has(tableNode.id) || this.hiddenFiles.has(fileNode.id)) continue;
          const fx = fileNode.x ?? 0;
          const fy = fileNode.y ?? 0;
          // Land on the table's drawn EDGE, not its centre: a table is painted
          // opaque over the lines, so a rope aimed at the middle would be
          // swallowed by the rectangle it was pointing at.
          const [tx, ty] = this.tableEdgeToward(tableNode, fx, fy);
          const dx = tx - fx;
          const dy = ty - fy;
          const len = Math.hypot(dx, dy) || 1;
          const bow = Math.min(len * 0.16, 60);
          const weight = link.verb === 'creates' ? 2.4 : link.verb === 'writes' ? 1.7 : 1.1;
          const ropeInk =
            pinnedTable === null || link.tableId === pinnedTable ? theme.evening : otherTableInk;
          // The standing answer steps back behind the front one, but stays
          // plainly drawn (hoverRecession) — a pinned table whose other ropes
          // fell to scenery would read as unpinned.
          ctx.globalAlpha =
            (link.verb === 'reads' ? 0.6 : 0.9) * hoverRecession(ofHover, ofPin);
          ctx.strokeStyle = ropeInk;
          ctx.lineWidth = weight / transform.k;
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.quadraticCurveTo(
            (fx + tx) / 2 - (dy / len) * bow,
            (fy + ty) / 2 + (dx / len) * bow,
            tx,
            ty,
          );
          ctx.stroke();
          ctx.fillStyle = ropeInk;
          ctx.beginPath();
          ctx.arc(tx, ty, 2.4 / transform.k + 1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // -- edges --
    // What the lit chain is drawn in: the folders a hovered FILE is kept in
    // hang off it by tree lines, and those lines wear that file's own colour
    // so the path up to where it lives belongs visibly to that dot. Resolved
    // once a frame rather than once a line, and only for a plain file —
    // a table's rectangle has no dot colour to lend.
    let chainInk: string | null = null;
    if (this.hoverFile !== null) {
      const litBody = this.simNodes.find((n) => n.id === this.hoverFile);
      if (litBody && litBody.node.kind === 'file' && !litBody.node.file?.table) {
        chainInk = this.fileDotInk(litBody, ramp, goldRamp, now / 1000, true);
      }
    }
    // The selection's own lines, so narrowing onto one of its files steps them
    // back rather than putting them out. Resolved once a frame, like chainInk.
    const pickedLines = this.selectionAnswer();
    ctx.lineWidth = 1 / transform.k;
    for (const link of this.simLinks) {
      const s = link.source as SimNode;
      const t = link.target as SimNode;
      // A line to a hidden dot would end in empty space, so it goes too —
      // the tree edge from its folder and any agent's tether alike.
      if (this.hiddenFiles.has(s.id) || this.hiddenFiles.has(t.id)) continue;
      // No rope from the database's folder to each table: standing on the
      // shelves already says they belong to it, and thirty-one lines fanning
      // out of one corner would bury the foreign keys, which are the lines
      // worth reading.
      if (link.kind !== 'fk' && (isTable(s) || isTable(t))) continue;
      // Nor any rope into a dot on the upload coil — same complaint as the
      // shelves, one order of magnitude worse: a hundred lines fanning out of
      // the folder at the coil's centre would fill the spiral solid and bury
      // the one line that's worth reading there, which is the strand running
      // along it (drawCoilStrand). A session tether still draws: which agent
      // opened which photo is exactly what the coil's own shape can't say.
      if ((link.kind ?? 'tree') === 'tree' && (this.onCoil(s) || this.onCoil(t))) continue;
      // A line with BOTH ends inside the lit answer is the hover's own: the
      // hovered file's chain of folders running up the tree, or a hovered
      // table's foreign keys. It draws at full strength wherever it runs,
      // including up out of a spotlight's footprint into the folders above.
      const litLine =
        this.hoverFile !== null && this.hoverFileKin.has(s.id) && this.hoverFileKin.has(t.id);
      const inPrint =
        litLine || !dimmed || this.footprintLit!.has(s.id) || this.footprintLit!.has(t.id);
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
        // The tree. A lit line — the chain from the hovered dot up to the
        // folders it's kept in — is drawn in that dot's colour and a little
        // heavier, so where the file lives is followed by eye rather than
        // traced; every other tree line stays the map's plain border grey.
        const chainLine = litLine && chainInk !== null;
        ctx.globalAlpha = inPrint ? 0.55 : 0.15;
        ctx.strokeStyle = chainLine ? chainInk! : theme.border;
        ctx.lineWidth = (chainLine ? 1.6 : 1) / transform.k;
        ctx.setLineDash([]);
      }
      // Everything but the hover's own line recedes under a file hover —
      // otherwise the tree stays at full strength while the dots fall away,
      // and the map reads as a skeleton with the flesh removed rather than as
      // one thing stepping back. In THREE tiers, not two (hoverRecession): a
      // line belonging to what she picked out — a spotlit agent's tether to
      // one of its other files, the tree limb showing where that agent has
      // been working — steps back but stays plainly there, because pointing
      // at one member of a selection is a second question and not a retraction
      // of the first. Only what neither answer named goes to scenery.
      if (this.hoverFile !== null && !litLine) {
        const ofSelection =
          pickedLines !== null && pickedLines.has(s.id) && pickedLines.has(t.id);
        ctx.globalAlpha *= hoverRecession(false, ofSelection);
      }
      // A line into a stale dot recedes with it (staleEdgeAlpha), so under
      // Types the whole limb goes quiet together instead of the dot leaving a
      // full-strength line hanging in the air. Multiplied in rather than set,
      // like the hover fade above it, so a spotlight or a hover still has the
      // last word on how far down the line goes.
      ctx.globalAlpha *= this.staleEdgeAlpha(s, t);
      if (link.kind === 'fk' && s.node.file?.table && t.node.file?.table) {
        // A foreign key runs UNDER the shelf: out of the bottom of the table
        // that holds the key, dipping below the baseline, and up into the
        // bottom of the table it points at — deeper the further it travels, so
        // long and short hops don't lie on top of each other. The dot marks
        // the pointed-at end, which is how the direction reads at a glance.
        const fromX = s.x ?? 0;
        const fromY = (s.y ?? 0) + tableSize(s.node.file.table).height / 2;
        const toX = t.x ?? 0;
        const toY = (t.y ?? 0) + tableSize(t.node.file.table).height / 2;
        const dip = Math.min(50, 14 + Math.abs(toX - fromX) * 0.12);
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.quadraticCurveTo((fromX + toX) / 2, Math.max(fromY, toY) + dip * 2, toX, toY);
        ctx.stroke();
        ctx.fillStyle = theme.evening;
        ctx.beginPath();
        ctx.arc(toX, toY, 2.4, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    this.drawCoilStrand(ctx, transform, theme, dimmed);

    // -- nodes --
    const minR = MIN_NODE_PX / transform.k;   // world units for a screen-px floor
    const threadHover = this.hoverFile;
    for (const n of this.simNodes) {
      // Outside the date range: skipped whole, so its rings, write core,
      // run halo and flash go with it.
      if (this.hiddenFiles.has(n.id)) continue;
      const inPrint = !dimmed || this.footprintLit!.has(n.id);
      // What the hover lit: the dot under the cursor, everything wired to it,
      // the folders it's kept in — and the picked-out body, which a hover
      // never cancels.
      const litByHover =
        threadHover !== null && (this.hoverFileKin.has(n.id) || this.isSubject(n));
      // A file hover pulls the whole map down around what it lit: the lit set
      // stays full and everything else recedes. The lit set comes UP to full
      // even where the spotlight had it faded — the folders one of a spotlit
      // agent's files lives in are outside that agent's footprint, and they
      // are the whole answer to where the file is kept.
      const kinAlpha = threadHover === null || litByHover ? 1 : UNSELECTED_FADE;
      const printAlpha = litByHover || inPrint ? 1 : UNSELECTED_FADE;
      ctx.globalAlpha = printAlpha * kinAlpha;
      // Never let a node shrink below a visible dot, however far out we are.
      const nr = Math.max(n.radius, minR);
      // Set by a branch that paints its own body (the dark ash+hue file dot),
      // so the one generic fill further down knows to stand aside.
      let bodyDrawn = false;
      // Set to a colour by the folder branch below, which makes it the test
      // for "this node is a hollow folder" everywhere after it.
      let folderStroke: string | null = null;
      // And, under Types, how that outline is split between the file types
      // inside it.
      let folderShares: { color: string; fraction: number }[] | null = null;

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
          // The "Types" toggle overrides every other HUE. The dot wears its
          // file type's GitHub colour — not green for new, not red or gold
          // for heat — on both surfaces. Heat still sets the dot's SIZE
          // (nodeRadius), so a busy file is a big dot of its type's colour.
          // Prompt: "a toggle that overrides the other colors when i toggle
          // it on".
          //
          // Stale files sink into the sky. The colour says what KIND of file
          // it is; how much of it is left says whether the file is still
          // alive — full at a fresh touch or run, gone by the Heat thumb, so
          // dead wood goes dark (black sky) or blank (light one) instead of
          // shouting in the same colour as the code she's working in. The
          // curve is staleTypeColor, up top, and the Heat slider is its dial.
          ctx.fillStyle = this.fileDotInk(n, ramp, goldRamp, now / 1000);
        } else if (fresh) {
          ctx.fillStyle = this.fileDotInk(n, ramp, goldRamp, now / 1000);
        } else if (theme.dark) {
          // Dark: an opaque ASH disc, then the LEAN hue over it at GLOW
          // opacity (vocabulary in the ramp block up top). Both fires share
          // the floor, and a file with both kinds of life turns between them
          // under the breath instead of one hiding the other. Painted here,
          // so the generic fill below is skipped; rings and halos still draw.
          // fileDotInk resolves this same pair into the one colour the lines
          // use — keep the two in step.
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
          ctx.fillStyle = this.fileDotInk(n, ramp, goldRamp, now / 1000);
        }
      } else {
        // Folders and repos: an OUTLINE, and what it's painted with. They're
        // the only hollow bodies on the map — a folder is a container, not a
        // mark, and an unfilled one lets the files inside it stay the thing
        // being looked at. (Everything below is deferred to the stroke, so
        // nothing sets a fillStyle here.)
        //
        // The outline answers whichever question the map is currently lit by,
        // rather than having a lens of its own:
        //   Types on  — the commonest file type beneath it (folderTypes.ts),
        //               so a Python package reads teal and frontend/ blue.
        //   otherwise — its subtree's own rolled-up heat, leaning gold when
        //               that subtree RAN, in the same two hues and on the same
        //               curve as the file dots. Cold, that lands on the plain
        //               border colour, which is where folders started.
        // Whatever is hiding dots is felt through the first of those: the
        // dominant type is counted over the files still on screen, so a
        // narrowed date range re-describes the outline over what's left.
        folderShares = this.typeColors ? (this.folderSharesOf(n.id) ?? null) : null;
        folderStroke = this.typeColors
          ? (folderShares?.[0].color ?? theme.border)
          : mixHex(
              theme.border,
              mixHex(EMBER_HOT, GOLD_HOT, leanOf(n.t, n.a)),
              glowAlpha(glowOf(n.t, n.a)),
            );
      }
      if (folderStroke !== null) {
        // A folder is only as present as the liveliest file beneath it. With
        // nothing live down there this is 0 and the folder simply isn't
        // painted — no outline around an empty branch. Multiplied into the
        // spotlight and hover alphas rather than replacing them, so those
        // still have the last word.
        const folderFade = this.folderFadeOf(n.id);
        if (folderFade <= 0.01) continue;
        ctx.globalAlpha *= folderFade;
        // Hollow: trace the folder and stroke it, never fill it. Drawn AS a
        // folder — the one place on this map where a node isn't a circle
        // (folderOutline says why, and why the tab comes and goes with the
        // zoom). A repo takes a heavier line than a folder: the two are the
        // same shape at different ranks, and rank was carried by size alone,
        // which a hot folder grown by its children's heat could eat up.
        const { height } = folderBox(nr);
        const outline = roundedPolygonPoints(
          folderOutline(n.x ?? 0, n.y ?? 0, nr, transform.k),
          height * 0.2,
        );
        ctx.lineWidth = (n.node.kind === 'repo' ? 2.6 : 1.8) / transform.k;
        // Big enough on screen to read as a mixture: paint each file type its
        // share of the border, so the folder says what's IN it and not only
        // what's commonest. Below that it's the commonest one, solid — the
        // same level-of-detail step the tab takes, and on the same threshold,
        // so a folder gains its notch and its languages in one move.
        if (folderShares !== null && folderShares.length > 1 && height * transform.k >= FOLDER_TAB_MIN_PX) {
          strokePolylineShares(ctx, outline, folderShares);
        } else {
          tracePolyline(ctx, outline);
          ctx.strokeStyle = folderStroke;
          ctx.stroke();
        }
      } else {
        if (!bodyDrawn) {
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, nr, 0, Math.PI * 2);
          ctx.fill();
        }
        if (n.node.kind === 'file') this.drawWriteCore(n, nr, now);
        // Ran inside the Active bar's window (note 8 in TerrainHeatBar.tsx).
        if (n.node.kind === 'file') this.drawRunHalo(n, nr);

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
      // Both rings are drawn ON THE BODY — the same world-space circle the
      // collider reserves (bodyRadiusOf) — so the physics has already made the
      // room and a ring can never lap over a neighbouring dot. The stroke
      // WEIGHT stays screen-locked: that's legibility, not geometry.
      //
      // Only when the body would actually show outside the dot. Far out, the
      // screen-pixel floor (minR) inflates the drawn dot past its real size
      // and the ring would fall inside the thing it rings — better no ring
      // than a ring that lies about where the dot ends. At those zooms it was
      // a sub-pixel hairline anyway.
      //
      // Prompt that produced it: "i want the outer ring to be the physics that
      // separates them" → "the only thing i care about is if the ring physics
      // causes the dots to move further apart so the rings aren't
      // overlapping".
      const bodyR = this.bodyRadiusOf(n);
      const ringVisible = bodyR > nr;
      if (dimmed && !ring && ringVisible && this.footprint!.has(n.id)) {
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 2 / transform.k;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, bodyR, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (ring && ringVisible) {
        // The ring is only ever as present as the dot it rings. Both fades
        // multiply in: the spotlight's (a search, or a tapped agent) and the
        // selected table's, so a ring can't keep shouting over a dot that has
        // gone quiet — whichever of the two selections quieted it.
        ctx.globalAlpha = ringAlpha * printAlpha * kinAlpha;
        ctx.strokeStyle = ring === 'read' ? READ_RING : this.orbStroke;
        ctx.lineWidth = 2.4 / transform.k;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, bodyR, 0, Math.PI * 2);
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
    // Name the files at the far end of a hovered table's code ropes, whatever
    // the spotlight rule above says. A rope to an unnamed dot only answers
    // half the question — she can see that something touches the table, but
    // not what — and hovering it IS the gesture that asks, the same way a
    // spotlit agent's footprint earns its captions.
    const ropeNamed =
      this.hoverFile !== null ? (this.codeLinkKin.get(this.hoverFile) ?? null) : null;
    /** Is this file one of the ones the map has been ASKED to name? */
    const named = (id: string) =>
      (namedFiles !== null && namedFiles.has(id)) || (ropeNamed !== null && ropeNamed.has(id));
    // Has she picked one body out? All three gestures count and mean the same
    // thing — a spotlit agent, a search (both arrive as `footprint`), and a
    // pinned table.
    const selectionUp = this.footprint !== null || this.heldFile !== null;
    // Pointing at one of the selection's own dots picks it OUT of the set
    // rather than adding to it — see the fade at the bottom of this loop.
    // Any dot she can point at while a selection is up IS one of its own,
    // since nothing outside it takes a hover (isTouchable).
    const pickedOut = selectionUp && this.hoverLabel !== null;
    for (const n of this.simNodes) {
      if (this.hiddenFiles.has(n.id)) continue; // no caption for a dot that isn't drawn
      if (n.node.file?.table) continue; // tables are named in their own pass, below
      const pointedAt = n.id === this.hoverLabel;
      // A dot names itself under the cursor — pointing at something is the
      // gesture that asks "what is this", and the answer is its name. The
      // faded dots outside a selection stay silent, as she asked, but that is
      // no longer this line's job: they can't be pointed at in the first
      // place (isTouchable), so the cursor only ever lands on a dot the map is
      // willing to talk about.
      //
      // Prompts that produced it: "i want for no names to pop up over the
      // unselected files that are still showing. i like that the names
      // otherwise pop up" / "the things that i hover over don't display the
      // name of the file anymore".
      const namesItself = pointedAt;
      if (n.node.kind === 'file' && !namesItself && !named(n.id)) continue;
      // Directories caption themselves at readable zoom on the map proper. In
      // the step-back view zoom is not hers to set, so the bound is relevance
      // instead: only the directories the focused agent is actually working
      // inside get named, however far out the camera happens to be sitting.
      // ...with one free pass: anything the HOVER lit names itself however far
      // out the camera sits, and wherever the spotlight left it. A folder the
      // hovered file is kept in is the clearest case — the hover has already
      // dimmed the map down to say where this file lives, and an unnamed
      // bright box answers half of that. Same pass the rope-ends get above.
      const litByHover =
        this.hoverFile !== null && (this.hoverFileKin.has(n.id) || this.isSubject(n));
      if (
        n.node.kind === 'dir' &&
        !litByHover &&
        (captioned ? !this.focusDirIds.has(n.id) : k < LABEL_MIN_K)
      )
        continue;
      // No name for a folder that isn't painted — under Types a branch with
      // nothing live in it goes entirely, label and all.
      if ((n.node.kind === 'dir' || n.node.kind === 'repo') && this.folderFadeOf(n.id) <= 0.01) continue;
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
      const inPrint = litByHover || !dimmed || this.footprintLit!.has(n.id);
      // ...and the same free pass at the spotlight's edge: a dot outside the
      // lit set is named only if pointing at it is still a question the map
      // is willing to answer, which it isn't once something is picked out.
      if (n.node.kind !== 'repo' && dimmed && !inPrint && !namesItself) continue;
      const sx = (n.x ?? 0) * k + transform.x;
      const sy = (n.y ?? 0) * k + transform.y;
      if (sx < -80 || sx > this.width + 80 || sy < -40 || sy > this.height + 40) continue;
      // Names follow their orbs into the background: with a hover up, the
      // other agents' titles recede alongside their rings rather than sitting
      // there at full weight over a map that's stopped talking about them.
      // A name recedes with its body: under a file hover everything outside
      // the lit answer steps back, caption and all, or the map dims while a
      // field of full-ink names sits on top of it unchanged.
      const kinLabelFade = this.hoverFile === null || litByHover ? 1 : UNSELECTED_FADE;
      ctx.globalAlpha =
        (hover !== null && n.node.kind === 'session' && !hovered ? 0.3 : 1) * kinLabelFade;
      if (n.node.kind === 'repo') {
        ctx.font = `700 ${LABEL_PX + 2}px ${this.fontFamily}`;
        ctx.fillStyle = theme.text;
        ctx.fillText(n.node.label, sx, sy - n.radius * k - 5);
      } else if (n.node.kind === 'dir') {
        ctx.font = `600 ${LABEL_PX}px ${this.fontFamily}`;
        ctx.fillStyle = theme.textSecondary;
        ctx.fillText(n.node.label, sx, sy - n.radius * k - 4);
        // The coil says how far back it goes, right under its own name. The
        // centre is a control — a tap opens the window a step wider — and a
        // control with no reading on it is one she has to remember rather
        // than see. It sits INSIDE the coil's centre hole, which is kept
        // clear of dots for exactly this (SPIRAL_INNER_RADIUS).
        if (this.coilCaption !== null && n.id === this.coil?.hub.id) {
          ctx.fillStyle = theme.textMuted;
          ctx.fillText(this.coilCaption, sx, sy + n.radius * k + LABEL_PX);
        }
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
        const ty = sy - n.radius * k - 4;
        // The one she's POINTING at is louder than that: full ink, on a plate
        // of the map's own background. The plate is what makes it readable —
        // a name in a dense field lands on top of other dots and their names,
        // and a hover has to answer immediately or it hasn't answered.
        if (pointedAt) {
          const plateWidth = ctx.measureText(n.node.label).width + 10;
          ctx.globalAlpha = 0.86;
          ctx.fillStyle = theme.bg;
          ctx.fillRect(sx - plateWidth / 2, ty - LABEL_PX - 2, plateWidth, LABEL_PX + 7);
          ctx.globalAlpha = 1;
          ctx.fillStyle = theme.text;
        } else {
          // Within a set of names she asked for, hovering one PICKS IT OUT:
          // the rest step back so the one under the cursor reads alone. Hover
          // focuses here rather than adding, which is what makes it safe to
          // sweep across a spotlit agent's footprint or a search's hits.
          //
          // Prompt that produced it: "hovering over them would make the
          // hovered one get brighter and the other ones fade".
          if (pickedOut) ctx.globalAlpha *= NAMED_FADE;
          ctx.fillStyle = theme.textSecondary;
        }
        ctx.fillText(n.node.label, sx, ty);
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

    // The shelf names: each family's word, muted, right-aligned so it ends
    // just before its shelf begins, sitting on the shelf's baseline. Screen space like every label, so never under 12px.
    ctx.textAlign = 'right';
    ctx.font = `600 ${LABEL_PX}px ${this.fontFamily}`;
    ctx.fillStyle = theme.textMuted;
    ctx.globalAlpha = kin === null ? 1 : 0.3;
    if (this.shelf && this.shelf.left !== null && this.shelf.top !== null) {
      for (const label of this.shelf.layout.shelfLabels) {
        ctx.fillText(
          label.text,
          (this.shelf.left + label.x) * k + transform.x - 12,
          (this.shelf.top + label.y) * k + transform.y,
        );
      }
    }
    ctx.textAlign = 'center';
    ctx.globalAlpha = 1;

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
      // their rectangles — except the PINNED table's own name, which holds
      // with its rectangle wherever the cursor has gone (isSubject).
      ctx.globalAlpha = kin === null || kin.has(n.id) || this.isSubject(n) ? 1 : 0.3;
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
