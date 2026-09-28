/**
 * swarmNetworkMath.ts — where each agent sits in a swarm's network drawing,
 * and which lines join them.
 *
 * What this is, in plain English: SwarmNetwork.tsx draws a swarm as rings
 * (its sessions) joined by lines (who has messaged whom). This file does the
 * arithmetic, kept apart from the drawing so it can be tested:
 *
 *   - placing the rings: two sit side by side; three or more stand evenly
 *     round a circle, first-joined at the top, the circle growing with the
 *     count so labels don't collide;
 *   - once a swarm is past a handful and some of it is retired, it becomes
 *     TWO circles round the helper: the active agents on the inner one, the
 *     retired ones smaller on an outer one (placeTwoRings). The outer ring
 *     prints its names only when there's room for them; otherwise a name
 *     shows on hover or a first tap. A very crowded outer ring zigzags
 *     between two radii so its rings keep a finger's width apart;
 *   - folding messages into lines: the server counts each direction apart
 *     (a→b and b→a); a line is one PAIR, carrying both counts, so a
 *     conversation is one line and not two laid on top of each other;
 *   - the green talk lines are member-to-member messages only. The helper
 *     gets a seat of its own instead: the middle of the members (the centre
 *     of the circle, halfway between two, beside a lone one);
 *   - the helper's own threads: a straight line from its seat to each
 *     member it has sent messages to, carrying how many;
 *   - placing the message counts so none covers another count, a ring, or
 *     a name: each slides along its own line to the first clear spot, and
 *     never leaves the line (placeCounts);
 *   - a continuation (one session taking over from another) is its own kind
 *     of line, since it's a handover rather than talk;
 *   - hiding retired sessions without orphaning their successors: a hidden
 *     session's lines move onto the live session that took over (withoutRetired).
 *
 * Touches: swarmApi.ts (the Swarm shape), SwarmNetwork.tsx (the drawing).
 *
 * Prompt that produced it: "a tree or like network of agents ... representing
 * the swarm with green lines between the purple agent rings showing which are
 * talking to which within the swarm." Then: "make it such that the helper is
 * connected to other agents in the swarm with the threads for messages it
 * sends." Then: "I'm wondering if retired agents should show in a ring
 * outside the active agents."
 */
import type { Swarm, MemberState } from './swarmApi';

/** The drawing is laid out in this coordinate width; the SVG scales it. */
export const NETWORK_WIDTH = 640;
/** Room above and below the rings for the ring itself and its two-line label. */
const MARGIN_TOP = 44;
const MARGIN_BOTTOM = 64;

export interface NetworkNode {
  conv: string;
  title: string;
  state: MemberState;
  /** Archived or handed on — drawn a step further back. */
  retired: boolean;
  /** Seated on the outer, retired ring — drawn smaller. */
  outer: boolean;
  /** Whether its name prints under it. False on a crowded outer ring,
   * where the name waits for a hover or a first tap. */
  named: boolean;
  x: number;
  y: number;
}

export interface NetworkLine {
  /** The pair, in the order they sort — a stable key. */
  a: string;
  b: string;
  /** Messages each way, and in total. */
  aToB: number;
  bToA: number;
  messages: number;
}

export interface NetworkLayout {
  width: number;
  height: number;
  nodes: NetworkNode[];
  talk: NetworkLine[];
  continues: { from: string; to: string }[];
  /** Where the swarm's helper sits: the middle of the members. */
  centre: { x: number; y: number };
  /** The helper's threads out to the members it has messaged. */
  helperThreads: HelperThread[];
}

export interface HelperThread {
  /** The member it goes to. */
  conv: string;
  messages: number;
  /** Where the member sits — the line runs from the helper's seat to here. */
  x: number;
  y: number;
}

/** Place the rings: side by side for two, evenly round a circle for more. */
export function placeRings(count: number): { x: number; y: number; height: number }[] {
  const middle = NETWORK_WIDTH / 2;
  if (count === 0) return [];
  if (count === 1) return [{ x: middle, y: MARGIN_TOP, height: MARGIN_TOP + MARGIN_BOTTOM }];
  if (count === 2) {
    const height = MARGIN_TOP + MARGIN_BOTTOM;
    return [
      { x: middle - 170, y: MARGIN_TOP, height },
      { x: middle + 170, y: MARGIN_TOP, height },
    ];
  }
  // The circle grows with the count so neighbouring labels keep ~170 units
  // apart along the rim, but never spills past the drawing's width.
  const radius = Math.min(NETWORK_WIDTH / 2 - 90, Math.max(120, (count * 170) / (2 * Math.PI)));
  const height = MARGIN_TOP + radius * 2 + MARGIN_BOTTOM;
  const centreY = MARGIN_TOP + radius;
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    return {
      x: Math.round(middle + radius * Math.cos(angle)),
      y: Math.round(centreY + radius * Math.sin(angle)),
      height,
    };
  });
}

/* ---- Two rings: active inside, retired outside ----
   A swarm with many finished sessions piles every name onto one circle.
   Past SPLIT_ABOVE members, if any are retired, the retired ones move to an
   outer ring. The numbers are drawing units (640 wide); on a phone one unit
   is about 0.72px. */

/** At or under this many members, a swarm stays one circle, as it always was. */
export const SPLIT_ABOVE = 6;
/** Outer ring with names showing: the same rim as the one-circle cap, so
 * names at the sides still fit the width. */
const OUTER_NAMED_RADIUS = 230;
/** Outer ring without names: pushed out near the edge, rings only. */
const OUTER_BARE_RADIUS = 286;
/** Room a named ring needs along the rim — the same as the one-circle rule. */
const NAMED_SPACING = 150;
/** Room a bare retired ring needs to stay a ~40px tap apart on a phone. */
const BARE_SPACING = 56;
/** How far in the second band of a zigzagging outer ring sits. */
const ZIGZAG_STEP = 40;

export interface TwoRings {
  inner: { x: number; y: number }[];
  outer: { x: number; y: number }[];
  /** Whether the outer ring has room to print its names. */
  outerNamed: boolean;
  /** The circles' shared middle: the helper's seat. */
  centre: { x: number; y: number };
  height: number;
}

/** Place the active agents on an inner circle and the retired ones on an
 * outer circle, both round the helper, each starting at the top. The outer
 * ring prints names only if each gets NAMED_SPACING of rim; otherwise it
 * moves out to the edge, and if even then its rings would sit closer than
 * BARE_SPACING, every other one steps in by ZIGZAG_STEP — two staggered
 * bands, so neighbours are still a tap apart. The inner circle grows with
 * its count like the one-circle rule, but always stays clear of the outer
 * ring's innermost band with room for its own names to hang. */
export function placeTwoRings(activeCount: number, retiredCount: number): TwoRings {
  const outerNamed = retiredCount * NAMED_SPACING <= 2 * Math.PI * OUTER_NAMED_RADIUS;
  const outerRadius = outerNamed ? OUTER_NAMED_RADIUS : OUTER_BARE_RADIUS;
  const zigzag = !outerNamed && retiredCount * BARE_SPACING > 2 * Math.PI * outerRadius;
  const innermostBand = outerRadius - (zigzag ? ZIGZAG_STEP : 0);
  const innerRadius = Math.min(innermostBand - 90, Math.max(100, (activeCount * 170) / (2 * Math.PI)));
  const middle = NETWORK_WIDTH / 2;
  const centre = { x: middle, y: MARGIN_TOP + outerRadius };
  // Seats evenly round a circle, first at the top; the radius may vary per seat.
  const round = (count: number, radiusOf: (i: number) => number) =>
    Array.from({ length: count }, (_, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      return {
        x: Math.round(centre.x + radiusOf(i) * Math.cos(angle)),
        y: Math.round(centre.y + radiusOf(i) * Math.sin(angle)),
      };
    });
  return {
    inner: round(activeCount, () => innerRadius),
    outer: round(retiredCount, (i) => (zigzag && i % 2 === 1 ? outerRadius - ZIGZAG_STEP : outerRadius)),
    outerNamed,
    centre,
    // Bare retired rings need no room below for a name.
    height: MARGIN_TOP + outerRadius * 2 + (outerNamed ? MARGIN_BOTTOM : MARGIN_TOP),
  };
}

/** The helper's seat: the middle of the rings. With one ring the middle is
 * the ring itself, so the helper sits beside it instead. */
export function centreOf(seats: { x: number; y: number }[]): { x: number; y: number } {
  if (seats.length === 0) return { x: NETWORK_WIDTH / 2, y: MARGIN_TOP };
  if (seats.length === 1) return { x: seats[0].x + 170, y: seats[0].y };
  const x = seats.reduce((sum, s) => sum + s.x, 0) / seats.length;
  const y = seats.reduce((sum, s) => sum + s.y, 0) / seats.length;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Fold per-direction message counts into one line per pair of members. */
export function foldLinks(links: Swarm['links'], members: Set<string>): NetworkLine[] {
  const byPair = new Map<string, NetworkLine>();
  for (const link of links) {
    if (link.from === link.to || !members.has(link.from) || !members.has(link.to)) continue;
    const [a, b] = [link.from, link.to].sort();
    const key = `${a}\u0000${b}`;
    const line = byPair.get(key) ?? { a, b, aToB: 0, bToA: 0, messages: 0 };
    if (link.from === a) line.aToB += link.messages;
    else line.bToA += link.messages;
    line.messages += link.messages;
    byPair.set(key, line);
  }
  return [...byPair.values()];
}

/** Draw the helper's threads: one straight line from its seat to each
 * member it has messaged. Where its count goes is placeCounts' job. */
export function helperThreads(
  links: Swarm['helper_links'],
  nodes: { conv: string; x: number; y: number }[],
): HelperThread[] {
  const at = new Map(nodes.map((n) => [n.conv, n] as const));
  const threads: HelperThread[] = [];
  for (const link of links ?? []) {
    const node = at.get(link.to);
    if (!node || link.messages <= 0) continue;
    threads.push({
      conv: link.to,
      messages: link.messages,
      x: node.x,
      y: node.y,
    });
  }
  return threads;
}

/** How thick a talk line is: thicker the more they've said, gently. */
export function lineWidth(messages: number): number {
  return Math.min(6, 2 + Math.log2(Math.max(1, messages)));
}

/** The whole drawing for one swarm. Members keep the server's order (who
 * joined first), so a ring doesn't jump seat as the swarm grows. */
export function layoutSwarm(
  swarm: Pick<Swarm, 'members' | 'links' | 'continues' | 'helper_links'>,
): NetworkLayout {
  const retiredCount = swarm.members.filter((m) => m.retired).length;
  let nodes: NetworkNode[];
  let centre: { x: number; y: number };
  let height: number;
  // Split into two rings once the swarm is past a handful and has retired
  // members; each ring keeps the server's order within it.
  if (retiredCount > 0 && swarm.members.length > SPLIT_ABOVE) {
    const rings = placeTwoRings(swarm.members.length - retiredCount, retiredCount);
    let innerAt = 0;
    let outerAt = 0;
    nodes = swarm.members.map((m) => {
      const outer = m.retired ?? false;
      const seat = outer ? rings.outer[outerAt++] : rings.inner[innerAt++];
      return {
        conv: m.conv, title: m.title, state: m.state, retired: outer, outer,
        named: !outer || rings.outerNamed, x: seat.x, y: seat.y,
      };
    });
    centre = rings.centre;
    height = rings.height;
  } else {
    const seats = placeRings(swarm.members.length);
    nodes = swarm.members.map((m, i) => ({
      conv: m.conv, title: m.title, state: m.state, retired: m.retired ?? false, outer: false,
      named: true, x: seats[i].x, y: seats[i].y,
    }));
    centre = centreOf(seats);
    height = seats[0]?.height ?? MARGIN_TOP + MARGIN_BOTTOM;
  }
  const members = new Set(nodes.map((n) => n.conv));
  return {
    width: NETWORK_WIDTH,
    height,
    nodes,
    talk: foldLinks(swarm.links, members),
    continues: (swarm.continues ?? []).filter((c) => members.has(c.from) && members.has(c.to)),
    centre,
    helperThreads: helperThreads(swarm.helper_links, nodes),
  };
}

/** Leave retired members out, moving their lines onto whoever carries
 * their work on. A retired session that handed over to a live one would
 * otherwise vanish with all its lines, leaving the live one looking
 * unconnected. Each hidden session's messages (to members and from the
 * helper) are credited to its nearest shown successor, following the
 * handover chain; a hidden session with no shown successor loses its lines.
 * Prompt that produced it: "Figure out why there's no session attached to
 * these in the view" — then "Build it". */
export function withoutRetired<S extends Pick<Swarm, 'members' | 'links' | 'continues' | 'helper_links'>>(
  swarm: S,
): S {
  const members = swarm.members.filter((m) => !m.retired);
  const shown = new Set(members.map((m) => m.conv));
  const nextOf = new Map((swarm.continues ?? []).map((c) => [c.from, c.to] as const));
  // Walk the handover chain to the first shown session; the seen-set stops a loop.
  const stand = (conv: string): string | null => {
    const seen = new Set<string>();
    let at: string | undefined = conv;
    while (at !== undefined && !seen.has(at)) {
      if (shown.has(at)) return at;
      seen.add(at);
      at = nextOf.get(at);
    }
    return null;
  };
  // Move each message count onto the shown stand-ins, adding up any that now share a pair.
  const links = new Map<string, { from: string; to: string; messages: number }>();
  for (const link of swarm.links) {
    const from = stand(link.from);
    const to = stand(link.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    const entry = links.get(key) ?? { from, to, messages: 0 };
    entry.messages += link.messages;
    links.set(key, entry);
  }
  const helperLinks = new Map<string, number>();
  for (const link of swarm.helper_links ?? []) {
    const to = stand(link.to);
    if (to) helperLinks.set(to, (helperLinks.get(to) ?? 0) + link.messages);
  }
  return {
    ...swarm,
    members,
    links: [...links.values()],
    continues: (swarm.continues ?? []).filter((c) => shown.has(c.from) && shown.has(c.to)),
    helper_links: [...helperLinks].map(([to, messages]) => ({ to, messages })),
  };
}

/** A title short enough to sit under a ring, cut at a word where it can be. */
export function shortTitle(title: string, max = 24): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/* ---- Placing the message counts so nothing overlaps ----
   The rings, names and counts are HTML in real pixels, laid over a drawing
   that scales, so how much of the drawing a name covers depends on how wide
   it's shown. Everything below works in drawing units, told how many screen
   pixels one unit is (pxPerUnit), and sizes things from the CSS
   (SwarmNetwork.module.css): a .node is up to 132px wide with its ring's
   centre 20px from its top; a name wraps at ~124px in lines ~17.5px tall.
   An outer-ring (retired) ring is smaller: 12px from centre to edge. */

/** A rectangle in drawing units. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Roughly how wide a name runs in pixels — about 7.5px a character at the
 * small font, wrapping at the node's inner width. */
const NAME_WRAP_PX = 124;
const CHARACTER_PX = 7.5;

/** What one agent covers on screen: its ring, and its name hanging below.
 * Two boxes, since the name is usually wider than the ring; just the ring
 * when no name prints (an empty name). ringPx is centre-to-edge. */
export function nodeBoxes(
  at: { x: number; y: number },
  name: string,
  pxPerUnit: number,
  ringPx = 18,
): Box[] {
  const unit = (px: number) => px / pxPerUnit;
  const ring = unit(ringPx);
  const ringBox = { left: at.x - ring, top: at.y - ring, right: at.x + ring, bottom: at.y + ring };
  if (!name) return [ringBox];
  const textPx = name.length * CHARACTER_PX;
  const lines = Math.max(1, Math.ceil(textPx / NAME_WRAP_PX));
  const halfName = unit(Math.min(NAME_WRAP_PX, textPx) / 2 + 4);
  return [
    ringBox,
    { left: at.x - halfName, top: at.y + ring, right: at.x + halfName,
      bottom: at.y + unit(ringPx + lines * 17.5 + 4) },
  ];
}

/** A count chip's size in pixels, with a few pixels' breathing room: at
 * least 24px of text box plus padding and border, 24px tall. */
function chipPx(text: string): { width: number; height: number } {
  return { width: Math.max(24, text.length * 9) + 14 + 6, height: 24 + 6 };
}

function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

export interface CountLine {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  text: string;
  /** Where along the line (0 = from, 1 = to) it would most like to sit. */
  prefer: number;
}

/** Place every count chip on its own line, covering as little as it can.
 * This is a greedy placement: lines are taken in order, and each slides
 * along its line — its preferred spot first, then stepping outward both
 * ways — and takes the first spot clear of every ring, name and chip
 * already placed (inside the drawing). If no spot on the line is clear, it
 * takes the one covering least: a chip may overlap something, but it never
 * leaves its line, so every number visibly sits on the line it counts.
 * Each placed chip becomes something the next must avoid.
 * Prompt that produced it: "there's really no reason they should be
 * floating" — counts nudged beside their line read as loose dots. */
export function placeCounts(
  lines: CountLine[],
  obstacles: Box[],
  pxPerUnit: number,
  bounds: { width: number; height: number },
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  const taken = [...obstacles];
  const steps = [0];
  for (let step = 0.025; step <= 0.8; step += 0.025) steps.push(step, -step);
  for (const line of lines) {
    const chip = chipPx(line.text);
    const halfWidth = chip.width / pxPerUnit / 2;
    const halfHeight = chip.height / pxPerUnit / 2;
    const dx = line.to.x - line.from.x;
    const dy = line.to.y - line.from.y;
    let best: { x: number; y: number } | null = null;
    let bestCover = Infinity;
    for (const step of steps) {
      const t = line.prefer + step;
      if (t < 0.1 || t > 0.9) continue;
      const spot = { x: line.from.x + dx * t, y: line.from.y + dy * t };
      const box = { left: spot.x - halfWidth, top: spot.y - halfHeight,
        right: spot.x + halfWidth, bottom: spot.y + halfHeight };
      const outside = box.left < 0 || box.top < 0 || box.right > bounds.width || box.bottom > bounds.height;
      const cover = taken.reduce((sum, other) => sum + overlapArea(box, other), 0) + (outside ? 1e6 : 0);
      if (cover < bestCover) {
        best = spot;
        bestCover = cover;
      }
      if (cover === 0) break;
    }
    const spot = best ?? { x: line.from.x + dx * line.prefer, y: line.from.y + dy * line.prefer };
    const rounded = { x: Math.round(spot.x), y: Math.round(spot.y) };
    placed.set(line.key, rounded);
    taken.push({ left: rounded.x - halfWidth, top: rounded.y - halfHeight,
      right: rounded.x + halfWidth, bottom: rounded.y + halfHeight });
  }
  return placed;
}
