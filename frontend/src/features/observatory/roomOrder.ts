/**
 * roomOrder.ts — the order cards stand in inside a room, and how a swarm's
 * card reads its members.
 *
 * What this is, in plain English: every room (and every swarm's own page)
 * stacks its cards by what they ask of her, top to bottom:
 *
 *   asking   orange  stopped on her — a question, or a command to approve.
 *                    The one that has waited LONGEST goes first.
 *   broken   red     the last turn failed
 *   working  purple  running now, or used inside the last hour
 *   resting  grey    idle — including unread replies (grey, orange dot)
 *
 * Inside every tier but the orange one, cards keep the order the page handed
 * them (the rail's Oldest/Newest toggle). Swarm cards take part in the same
 * order as sessions: a swarm with a member waiting on her stands among the
 * orange sessions, ranked by that member's wait.
 *
 * "How long it has waited" is read from `last_at` — the last time the session
 * did anything. A session that's asking has stopped, so that's when it
 * stopped; nothing else stamps the moment a question was filed.
 *
 * Swarms: the server knows who's running and who asked, but not what she has
 * read (that lives in her browser) nor pending approvals, so a swarm card is
 * coloured here from the SAME roster and the SAME rule as the session cards
 * (sessionFilters). Retired members — archived, or handed on to a
 * continuation — are left off the card and out of its counts.
 *
 * Touches: SessionLane.tsx (orders a room with it), SwarmCard.tsx and
 * SwarmPage.tsx (draw a swarm through swarmView), sessionFilters.ts (the
 * colour rule), swarmApi.ts (the swarm types).
 *
 * Prompt that produced it: "sessions that are orange float to the top, sorting
 * at the oldest at the top and in descending order above the working or done
 * ones. then make the front page of the swarm also signal the orange ones and
 * put them in this same order. remove retired ones from the front page and
 * then make the inactive/done ones grey." · "i want the orange ones to only be
 * those that need input."
 */
import type { SessionMeta } from './api';
import { cardState, isAsking } from './sessionFilters';
import { swarmState, type MemberState, type Swarm, type SwarmMember } from './swarmApi';

export type RoomTier = 'asking' | 'broken' | 'working' | 'resting';

const TIER_RANK: Record<RoomTier, number> = { asking: 0, broken: 1, working: 2, resting: 3 };

/** Which tier a session stands in. Asking is checked first, ahead of the card's
 * own colour: a session can be running AND waiting on her, and the room draws
 * it as the orange asking card either way. */
export function sessionTier(
  meta: SessionMeta,
  openedAt: string | undefined,
  nowMs: number = Date.now(),
): RoomTier {
  if (isAsking(meta)) return 'asking';
  const state = cardState(meta, openedAt, nowMs);
  if (state === 'error') return 'broken';
  if (state === 'running' || state === 'recent') return 'working';
  return 'resting';
}

/** One thing to place in a room: a session row or a swarm, its tier, and —
 * for the orange ones — since when it has waited. */
export interface RoomPlace<T> {
  item: T;
  tier: RoomTier;
  waitingSince?: string;
}

/** Stack a room: by tier, the orange ones longest-waiting first, and
 * everything else in the order it arrived. A stable sort, so a poll that
 * changes nothing moves nothing. An orange card with no readable time goes
 * after the ones that have one. */
export function orderRoom<T>(places: RoomPlace<T>[]): T[] {
  const waited = (p: RoomPlace<T>) => {
    const ms = Date.parse(p.waitingSince ?? '');
    return Number.isNaN(ms) ? Infinity : ms;
  };
  return places
    .map((place, index) => ({ place, index }))
    .sort((a, b) => {
      const byTier = TIER_RANK[a.place.tier] - TIER_RANK[b.place.tier];
      if (byTier !== 0) return byTier;
      if (a.place.tier === 'asking') {
        const wa = waited(a.place);
        const wb = waited(b.place);
        if (wa !== wb) return wa < wb ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ place }) => place.item);
}

/** A swarm member as its card draws it: the state from the roster, and
 * whether there's a reply she hasn't read (a grey chip with an orange dot). */
export interface SwarmMemberView extends SwarmMember {
  unread: boolean;
  /** The member's last activity, from the roster — how long an asking member
   * has waited. Absent when the roster doesn't carry it. */
  lastAt?: string;
}

export interface SwarmView {
  swarm: Swarm;
  /** Live members only — retired ones are dropped. */
  members: SwarmMemberView[];
  counts: Record<MemberState, number>;
  state: MemberState;
  /** The longest-waiting asking member's last activity, for the room's order. */
  waitingSince?: string;
}

/** Read a swarm through the roster. A member the roster doesn't carry (it may
 * have been archived since) keeps the server's own state for it. */
export function swarmView(
  swarm: Swarm,
  metaById: Map<string, SessionMeta>,
  opened: Record<string, string>,
  nowMs: number = Date.now(),
): SwarmView {
  const counts: Record<MemberState, number> = { working: 0, silent: 0, needs_input: 0 };
  let waitingSince: string | undefined;
  const members: SwarmMemberView[] = [];
  for (const member of swarm.members) {
    if (member.retired) continue;
    const meta = metaById.get(member.conv);
    let state: MemberState = member.state;
    let unread = false;
    if (meta) {
      state = isAsking(meta) ? 'needs_input' : meta.running ? 'working' : 'silent';
      unread = cardState(meta, opened[member.conv], nowMs) === 'unread';
      // The swarm waits as long as its longest-waiting member.
      // Date.parse, not string order: stamps here aren't all in one format.
      if (
        state === 'needs_input' &&
        !Number.isNaN(Date.parse(meta.last_at ?? '')) &&
        (!waitingSince || Date.parse(meta.last_at) < Date.parse(waitingSince))
      ) {
        waitingSince = meta.last_at;
      }
    }
    counts[state] += 1;
    members.push({ ...member, state, unread, lastAt: meta?.last_at });
  }
  return { swarm, members, counts, state: swarmState({ counts }), waitingSince };
}

/** A swarm's members in the room's own order: asking (longest-waiting first),
 * then working, then silent — what the swarm card's chips follow. */
export function orderMembers(members: SwarmMemberView[]): SwarmMemberView[] {
  return orderRoom(
    members.map((member) => ({
      item: member,
      tier: (member.state === 'needs_input'
        ? 'asking'
        : member.state === 'working'
          ? 'working'
          : 'resting') as RoomTier,
      waitingSince: member.lastAt,
    })),
  );
}

/** A swarm's tier in its room, from its drawn state. */
export function swarmTier(view: SwarmView): RoomTier {
  if (view.state === 'needs_input') return 'asking';
  if (view.state === 'working') return 'working';
  return 'resting';
}
