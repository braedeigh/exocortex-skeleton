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
 *   - folding messages into lines: the server counts each direction apart
 *     (a→b and b→a); a line is one PAIR, carrying both counts, so a
 *     conversation is one line and not two laid on top of each other;
 *   - only member-to-member messages count — the helper talks to everyone,
 *     and a line to it would say nothing. It gets a seat of its own instead:
 *     the middle of the members (the centre of the circle, halfway between
 *     two, beside a lone one), and a line's message count slides off the
 *     middle when that middle is where the helper sits;
 *   - a continuation (one session taking over from another) is its own kind
 *     of line, since it's a handover rather than talk.
 *
 * Touches: swarmApi.ts (the Swarm shape), SwarmNetwork.tsx (the drawing).
 *
 * Prompt that produced it: "a tree or like network of agents ... representing
 * the swarm with green lines between the purple agent rings showing which are
 * talking to which within the swarm."
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
  // The circle grows with the count so neighbouring labels keep ~120 units
  // apart along the rim, but never spills past the drawing's width.
  const radius = Math.min(NETWORK_WIDTH / 2 - 90, Math.max(120, (count * 120) / (2 * Math.PI)));
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

/** The helper's seat: the middle of the rings. With one ring the middle is
 * the ring itself, so the helper sits beside it instead. */
export function centreOf(seats: { x: number; y: number }[]): { x: number; y: number } {
  if (seats.length === 0) return { x: NETWORK_WIDTH / 2, y: MARGIN_TOP };
  if (seats.length === 1) return { x: seats[0].x + 170, y: seats[0].y };
  const x = seats.reduce((sum, s) => sum + s.x, 0) / seats.length;
  const y = seats.reduce((sum, s) => sum + s.y, 0) / seats.length;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Where a line's message count sits: its middle, unless the helper sits
 * there — then a third of the way along, so the two don't overlap. */
export function countSpot(
  a: { x: number; y: number },
  b: { x: number; y: number },
  centre: { x: number; y: number },
): { x: number; y: number } {
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (Math.hypot(middle.x - centre.x, middle.y - centre.y) > 50) return middle;
  return { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 };
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

/** How thick a talk line is: thicker the more they've said, gently. */
export function lineWidth(messages: number): number {
  return Math.min(6, 2 + Math.log2(Math.max(1, messages)));
}

/** The whole drawing for one swarm. Members keep the server's order (who
 * joined first), so a ring doesn't jump seat as the swarm grows. */
export function layoutSwarm(swarm: Pick<Swarm, 'members' | 'links' | 'continues'>): NetworkLayout {
  const seats = placeRings(swarm.members.length);
  const nodes = swarm.members.map((m, i) => ({
    conv: m.conv, title: m.title, state: m.state, retired: m.retired ?? false,
    x: seats[i].x, y: seats[i].y,
  }));
  const members = new Set(nodes.map((n) => n.conv));
  return {
    width: NETWORK_WIDTH,
    height: seats[0]?.height ?? MARGIN_TOP + MARGIN_BOTTOM,
    nodes,
    talk: foldLinks(swarm.links, members),
    continues: (swarm.continues ?? []).filter((c) => members.has(c.from) && members.has(c.to)),
    centre: centreOf(seats),
  };
}

/** A title short enough to sit under a ring, cut at a word where it can be. */
export function shortTitle(title: string, max = 24): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}
