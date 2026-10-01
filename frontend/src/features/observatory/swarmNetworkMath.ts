/**
 * swarmNetworkMath.ts — where each agent sits in a swarm's network drawing,
 * and which lines join them.
 *
 * What this is, in plain English: SwarmNetwork.tsx draws a swarm as rings
 * (its sessions) joined by lines (who has messaged whom). This file does the
 * arithmetic, kept apart from the drawing so it can be tested:
 *
 *   - fitting the drawing to the width it is shown at (layoutSwarm): the
 *     helper's seat is the middle, and the members sit round it as far out
 *     as they fit. One sits beside the helper; two sit either side, lifted
 *     a little above it; three or more stand evenly round a circle,
 *     first-joined at the top. A name hangs under its ring, or sits above
 *     it for a seat above the helper, so the lines running inward don't
 *     cross it. Names narrow on a narrow screen, and a ring
 *     with no room for its names prints rings only; a name then shows on
 *     hover or a first tap. Inside a round bubble everything stays inside
 *     the circle, the helper at its exact centre;
 *   - once a swarm is past a handful and some of it is retired, it becomes
 *     TWO circles round the helper: the active agents on the inner one, the
 *     retired ones smaller on an outer one. A very crowded ring zigzags
 *     between two radii so its rings keep a finger's width apart;
 *   - folding messages into lines: the server counts each direction apart
 *     (a→b and b→a); a line is one PAIR, carrying both counts, so a
 *     conversation is one line and not two laid on top of each other;
 *   - the green talk lines are member-to-member messages only. The helper
 *     gets a seat of its own instead: the middle of the drawing;
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
 * outside the active agents." Then: "I also want this to be centered with
 * the helper in the middle and not be scrolly around."
 */
import type { Swarm, MemberState } from './swarmApi';

/** The widest the drawing is laid out, in pixels. Shown wider than this,
 * the same layout is scaled up (the names stay their size, so it only gets
 * roomier). */
export const NETWORK_WIDTH = 640;
/** The narrowest it is laid out. Shown narrower still, it is scaled down. */
export const NARROWEST_WIDTH = 200;

export interface NetworkNode {
  conv: string;
  title: string;
  state: MemberState;
  /** Archived or handed on — drawn a step further back. */
  retired: boolean;
  /** Seated on the outer, retired ring — drawn smaller. */
  outer: boolean;
  /** Whether its name prints under it. False on a ring too crowded for
   * names, where the name waits for a hover or a first tap. */
  named: boolean;
  /** Whether the name sits above the ring instead of hanging below it. */
  nameAbove: boolean;
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
  /** Where the swarm's helper sits: the middle, with the members round it. */
  centre: { x: number; y: number };
  /** The helper's threads out to the members it has messaged. */
  helperThreads: HelperThread[];
  /** How wide a name may run under its ring, in pixels, at this width. */
  nameWidth: number;
}

export interface HelperThread {
  /** The member it goes to. */
  conv: string;
  messages: number;
  /** Where the member sits — the line runs from the helper's seat to here. */
  x: number;
  y: number;
}

/* ---- Seating the rings so the drawing fits the width it's shown at ----
   The rings and names are HTML in real pixels, so a drawing can't simply be
   shrunk: the seats would close up while the names stayed the same size.
   Instead the layout is told how wide it is shown and seats everything in
   pixels, relative to the helper's seat in the middle (0, 0). Each ring of
   seats takes the largest radius at which every ring and name still sits
   inside the frame. The sizes below are pixels, read off
   SwarmNetwork.module.css. */

/** At or under this many members, a swarm stays one circle. Past it, if any
 * are retired, the retired ones move to an outer ring. */
export const SPLIT_ABOVE = 6;
/** A member's ring, centre to edge; a retired one on the outer ring is smaller. */
const RING_PX = 18;
const OUTER_RING_PX = 12;
/** Half the tap target of a ring whose name isn't printed (44px). */
const BARE_HALF = 22;
/** The closest a ring of seats comes to the helper: room for the helper's
 * dot, the member's ring and a count chip on the line between them. */
const HELPER_CLEAR = 64;
/** Nameless rings sit at least this far apart, centre to centre: a tap each. */
const BARE_SPACING = 44;
/** How far in the second band of a zigzagging ring sits. */
const ZIGZAG_STEP = 30;
/** How far two members are lifted above the helper: 20 degrees. */
const PAIR_LIFT = (20 * Math.PI) / 180;
/** Clear space above and below the drawing when its height is free. */
const EDGE_PAD = 8;

/** How wide a name may run under its ring: a third of the drawing, between
 * 92px (about a dozen characters a line) and the 132px it has on a desk. */
export function nameWidthFor(width: number): number {
  return Math.max(92, Math.min(132, Math.round(width / 3)));
}

interface Seat {
  x: number;
  y: number;
}

/** What the drawing has to stay inside, measured from the helper's seat.
 * `holds` says whether a box is inside it; `holdsRing` says whether a
 * nameless ring's round tap target is. */
interface Frame {
  holds: (box: Box) => boolean;
  holdsRing: (seat: Seat) => boolean;
}

/** The directions a ring's seats lie in, from the middle. One member sits
 * to the left. Two sit left and right; round a helper they are lifted a
 * little above it, so the talk line between them passes over the helper's
 * dot instead of through it, and the helper's threads miss their names.
 * Three or more stand evenly round, the first at the top. */
function seatAngles(count: number, aroundHelper: boolean): number[] {
  if (count === 1) return [Math.PI];
  if (count === 2) return aroundHelper ? [Math.PI + PAIR_LIFT, -PAIR_LIFT] : [Math.PI, 0];
  return Array.from({ length: count }, (_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / count);
}

/** Whether a seat's name goes above its ring. Names point away from the
 * middle: a seat above the helper has its name on top, so the lines running
 * in to the helper and across to its neighbours don't cross the name. */
function nameGoesAbove(seat: Seat): boolean {
  return seat.y < -1;
}

/** The button round a ring: wider than the ring when a name hangs under it.
 * Nothing shows there, but it must stay inside the drawing so the page
 * never grows sideways. */
function buttonBox(seat: Seat, half: number): Box {
  return { left: seat.x - half, top: seat.y - 24, right: seat.x + half, bottom: seat.y + 24 };
}

interface RingPlan {
  seats: Seat[];
  /** Whether there was room to print the names. */
  named: boolean;
  /** The radius of its innermost seats: what a ring inside it must clear. */
  innermost: number;
}

/** Seat one ring of agents round the middle, as far out as it fits.
 * The names print if there is a radius, no bigger than `want` or `most`,
 * where every ring and name is inside the frame, clear of everything in
 * `avoid`, and no two names overlap. It tries the biggest radius first and
 * steps in until that holds. If none does, the names are left off (they
 * show on hover or a first tap) and the bare rings go as far out as they
 * fit; if even then neighbours would be closer than a tap, every other one
 * steps in by ZIGZAG_STEP — two staggered bands. */
function placeRing(
  names: string[],
  room: {
    /** The radius it would like; `most` is the radius it may not pass. */
    want: number;
    most: number;
    frame: Frame;
    avoid: Box[];
    nameWidth: number;
    ringPx: number;
    aroundHelper: boolean;
    allowNames: boolean;
  },
): RingPlan {
  if (names.length === 0) return { seats: [], named: true, innermost: room.most };
  const angles = seatAngles(names.length, room.aroundHelper);
  const seatsAt = (radius: number, zigzag = false): Seat[] =>
    angles.map((angle, i) => {
      const reach = zigzag && i % 2 === 1 ? radius - ZIGZAG_STEP : radius;
      return { x: reach * Math.cos(angle), y: reach * Math.sin(angle) };
    });
  const touches = (boxes: Box[], others: Box[]) =>
    boxes.some((box) => others.some((other) => overlapArea(box, other) > 0));
  const fits = (radius: number, named: boolean): boolean => {
    const seats = seatsAt(radius);
    const covers = seats.map((seat, i) =>
      nodeBoxes(seat, named ? names[i] : '', 1, room.ringPx, room.nameWidth - 8, nameGoesAbove(seat)));
    return seats.every((seat, i) => {
      const inside = named
        ? [...covers[i], buttonBox(seat, room.nameWidth / 2)].every(room.frame.holds)
        : room.frame.holdsRing(seat);
      if (!inside) return false;
      if (touches(covers[i], room.avoid)) return false;
      return !named || covers.slice(0, i).every((earlier) => !touches(covers[i], earlier));
    });
  };
  const largest = (named: boolean, from: number): number | null => {
    for (let radius = from; radius >= HELPER_CLEAR; radius -= 2) {
      if (fits(radius, named)) return radius;
    }
    return null;
  };

  const namedRadius = room.allowNames ? largest(true, Math.min(room.want, room.most)) : null;
  if (namedRadius !== null) return { seats: seatsAt(namedRadius), named: true, innermost: namedRadius };

  const radius = largest(false, room.most) ?? Math.max(BARE_SPACING, Math.min(room.most, HELPER_CLEAR));
  const neighbours = names.length < 2 ? Infinity : 2 * radius * Math.sin(Math.PI / names.length);
  const zigzag = neighbours < BARE_SPACING;
  return { seats: seatsAt(radius, zigzag), named: false, innermost: radius - (zigzag ? ZIGZAG_STEP : 0) };
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

/** The whole drawing for one swarm, fitted to the width it is shown at.
 * The helper's seat is the middle and the members sit round it; members
 * keep the server's order (who joined first), so a ring doesn't jump seat
 * as the swarm grows.
 *
 * `shownWidth` is how many pixels wide the drawing is on screen. `round`
 * says it sits inside a circle that wide (the bubble in SwarmStack): then
 * everything stays inside that circle and the helper is its exact centre.
 * Otherwise only the width is fixed, and the drawing is as tall as it needs.
 * Prompt that produced it: "I also want this to be centered with the helper
 * in the middle and not be scrolly around." */
export function layoutSwarm(
  swarm: Pick<Swarm, 'members' | 'links' | 'continues' | 'helper_links'> & { helper_conv?: string | null },
  shownWidth: number = NETWORK_WIDTH,
  round = false,
): NetworkLayout {
  const width = Math.round(Math.max(NARROWEST_WIDTH, Math.min(NETWORK_WIDTH, shownWidth)));
  const nameWidth = nameWidthFor(width);
  const hasHelper = !!swarm.helper_conv;
  // The frame: a circle a few pixels inside the bubble's edge, or just the
  // two sides of the drawing.
  const frame: Frame = round
    ? {
      holds: (box) => Math.hypot(Math.max(-box.left, box.right), Math.max(-box.top, box.bottom)) <= width / 2 - 4,
      holdsRing: (seat) => Math.hypot(seat.x, seat.y) + BARE_HALF <= width / 2 - 4,
    }
    : {
      holds: (box) => box.left >= -width / 2 && box.right <= width / 2,
      holdsRing: (seat) => Math.abs(seat.x) + BARE_HALF <= width / 2,
    };
  const helperCover = hasHelper ? nodeBoxes({ x: 0, y: 0 }, 'Helper', 1) : [];
  const nameOf = (member: { title: string }) => shortTitle(member.title);
  // The radius a ring of names would like: enough rim for each name, far
  // enough out that a name beside the helper stays clear of the helper's
  // own, and no smaller than `least`. The frame may allow less.
  const spread = (count: number, least: number) =>
    Math.max(least, nameWidth / 2 + 56, (count * (nameWidth + 38)) / (2 * Math.PI));
  const shared = { frame, nameWidth, aroundHelper: hasHelper };

  // Seat the members. Past a handful, with some retired, they split into
  // two rings: the retired ones outside, smaller, and the active ones inside.
  const retired = swarm.members.filter((m) => m.retired);
  const active = swarm.members.filter((m) => !m.retired);
  const split = retired.length > 0 && swarm.members.length > SPLIT_ABOVE;
  let innerRing: RingPlan | null = null;
  let outerRing: RingPlan | null = null;
  if (split) {
    // The outer ring goes as far out as it fits; the inner ring then has to
    // clear it. If printing the retired names leaves no room for the active
    // ones' names, the retired ring gives its names up.
    const place = (outerNames: boolean) => {
      const outer = placeRing(retired.map(nameOf), {
        ...shared, want: width / 2, most: width / 2, avoid: helperCover, ringPx: OUTER_RING_PX, allowNames: outerNames,
      });
      const outerCovers = outer.seats.flatMap((seat, i) =>
        nodeBoxes(seat, outer.named ? nameOf(retired[i]) : '', 1, OUTER_RING_PX, nameWidth - 8, nameGoesAbove(seat)));
      const inner = placeRing(active.map(nameOf), {
        ...shared, want: spread(active.length, 100), most: outer.innermost - BARE_SPACING,
        avoid: [...helperCover, ...outerCovers], ringPx: RING_PX, allowNames: true,
      });
      return { outer, inner };
    };
    let rings = place(true);
    if (rings.outer.named && !rings.inner.named) rings = place(false);
    // On a very small drawing there is no room for a second ring between
    // the outer one and the helper: everyone then shares one ring, below.
    if (active.length === 0 || rings.outer.innermost - BARE_SPACING >= HELPER_CLEAR) {
      innerRing = rings.inner;
      outerRing = rings.outer;
    }
  }
  if (innerRing !== null) {
    // Seated above, on two rings.
  } else if (!hasHelper && swarm.members.length === 1) {
    // One member and no helper: it takes the middle itself.
    innerRing = { seats: [{ x: 0, y: 0 }], named: true, innermost: 0 };
  } else {
    const count = swarm.members.length;
    innerRing = placeRing(swarm.members.map(nameOf), {
      ...shared, want: spread(count, count <= 2 ? 170 : 120), most: width / 2, avoid: helperCover,
      ringPx: RING_PX, allowNames: true,
    });
  }
  let innerAt = 0;
  let outerAt = 0;
  const placed = swarm.members.map((m) => {
    const outer = outerRing !== null && (m.retired ?? false);
    const ring = outer ? outerRing! : innerRing!;
    return { member: m, outer, named: ring.named, seat: ring.seats[outer ? outerAt++ : innerAt++] };
  });

  // Frame the drawing top to bottom. In a circle it is a square with the
  // helper at its centre. Otherwise it is as tall as what it holds: from the
  // highest ring to the lowest name, with a little clear space.
  const covers = [
    ...helperCover,
    ...placed.flatMap((p) => [
      ...nodeBoxes(p.seat, p.named ? nameOf(p.member) : '', 1, p.outer ? OUTER_RING_PX : RING_PX, nameWidth - 8,
        nameGoesAbove(p.seat)),
      buttonBox(p.seat, BARE_HALF),
    ]),
  ];
  const top = round ? -width / 2 : Math.min(-24, ...covers.map((box) => box.top)) - EDGE_PAD;
  const bottom = round ? width / 2 : Math.max(24, ...covers.map((box) => box.bottom)) + EDGE_PAD;
  const centre = { x: width / 2, y: Math.round(-top) };

  const nodes: NetworkNode[] = placed.map((p) => ({
    conv: p.member.conv, title: p.member.title, state: p.member.state, retired: p.member.retired ?? false,
    outer: p.outer, named: p.named, nameAbove: p.named && nameGoesAbove(p.seat), x: Math.round(centre.x + p.seat.x), y: Math.round(centre.y + p.seat.y),
  }));
  const members = new Set(nodes.map((n) => n.conv));
  return {
    width,
    height: Math.round(bottom - top),
    nodes,
    talk: foldLinks(swarm.links, members),
    continues: (swarm.continues ?? []).filter((c) => members.has(c.from) && members.has(c.to)),
    centre,
    helperThreads: helperThreads(swarm.helper_links, nodes),
    nameWidth,
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

/* ---- What covers what: boxes for the rings, names and counts ----
   The rings, names and counts are HTML in real pixels, laid over a drawing
   that may be scaled, so how much of the drawing a name covers depends on
   how wide it's shown. Everything below works in drawing units, told how
   many screen pixels one unit is (pxPerUnit), and sizes things from the CSS
   (SwarmNetwork.module.css): a ring's centre is 20px from the top of its
   button; a name wraps a few pixels inside the button's width, in lines
   ~17.5px tall. An outer-ring (retired) ring is smaller: 12px from centre
   to edge. */

/** A rectangle in drawing units. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Roughly how wide a name runs in pixels — about 6.5px a character at the
 * small font (measured nearer 5.5px on her phone, so this errs wide),
 * wrapping at the button's inner width (124px at its widest). */
const NAME_WRAP_PX = 124;
const CHARACTER_PX = 6.5;

/** What one agent covers on screen: its ring, and its name hanging below
 * (or sitting above, when `above`). Two boxes, since the name is usually
 * wider than the ring; just the ring when no name prints (an empty name).
 * ringPx is centre-to-edge; wrapPx is the width the name wraps at. */
export function nodeBoxes(
  at: { x: number; y: number },
  name: string,
  pxPerUnit: number,
  ringPx = 18,
  wrapPx = NAME_WRAP_PX,
  above = false,
): Box[] {
  const unit = (px: number) => px / pxPerUnit;
  const ring = unit(ringPx);
  const ringBox = { left: at.x - ring, top: at.y - ring, right: at.x + ring, bottom: at.y + ring };
  if (!name) return [ringBox];
  const textPx = name.length * CHARACTER_PX;
  const lines = Math.max(1, Math.ceil(textPx / wrapPx));
  const halfName = unit(Math.min(wrapPx, textPx) / 2 + 4);
  const nameTall = unit(lines * 17.5 + 4);
  return [
    ringBox,
    above
      ? { left: at.x - halfName, top: at.y - ring - nameTall, right: at.x + halfName, bottom: at.y - ring }
      : { left: at.x - halfName, top: at.y + ring, right: at.x + halfName, bottom: at.y + ring + nameTall },
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
