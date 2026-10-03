/**
 * terrainMessages.ts — which agents on the map have messaged each other, as
 * the lines the map draws between their orbs.
 *
 * What this is, in plain English: the Observatory draws a swarm as rings
 * joined by lines — green where two members have talked, blue from the
 * swarm's helper to each member it has written to. This file turns the same
 * swarm data (/api/swarms, already fetched for the swarm outlines) into the
 * same lines for the Terrain map, so the two pages say one thing in one set
 * of colours. Each line carries how many messages went each way, which is
 * what puts the arrowheads on it.
 *
 * The drawing happens in terrainCanvas.ts (drawMessageThreads), with the
 * arrow geometry shared from observatory/messageArrows.ts; TerrainPage.tsx
 * fetches the swarms and hands the lines over. A line whose two orbs aren't
 * both on the map is skipped at draw time — a helper often has no orb, since
 * an orb only appears for a session that touched files.
 *
 * Prompt that produced it: "I want messages to also be shown on terrain with
 * the same color threads."
 */
import { foldLinks } from '../observatory/swarmNetworkMath';
import type { Swarm } from '../observatory/swarmApi';

export interface MessageThread {
  /** The two agents, by conversation id. */
  a: string;
  b: string;
  /** Messages each way. A head is drawn at the end that received some. */
  aToB: number;
  bToA: number;
  messages: number;
  /** Member-to-member talk (green), or the helper writing to a member (blue). */
  kind: 'talk' | 'helper';
}

/** Every message line across the given swarms: one per pair of members that
 * have talked, and one from each swarm's helper to each member it has
 * written to. */
export function messageThreads(
  swarms: readonly Pick<Swarm, 'members' | 'links' | 'helper_conv' | 'helper_links'>[],
): MessageThread[] {
  const threads: MessageThread[] = [];
  for (const swarm of swarms) {
    const members = new Set(swarm.members.map((member) => member.conv));
    for (const line of foldLinks(swarm.links, members)) threads.push({ ...line, kind: 'talk' });
    if (!swarm.helper_conv) continue;
    for (const link of swarm.helper_links ?? []) {
      if (link.messages <= 0 || !members.has(link.to)) continue;
      threads.push({
        a: swarm.helper_conv, b: link.to, aToB: link.messages, bToA: 0, messages: link.messages, kind: 'helper',
      });
    }
  }
  return threads;
}
