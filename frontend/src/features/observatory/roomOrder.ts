/**
 * roomOrder.ts — the order cards stand in inside a room, and how a swarm's
 * card reads its members.
 *
 * What this is, in plain English: every room (and every swarm's own page)
 * stacks its cards in three bands, top to bottom:
 *
 *   waiting  idle and not done, so waiting for her next word. The ones
 *            wearing orange come first (a question, a command to approve, a
 *            failed turn, a reply she hasn't read); then the ones she has
 *            already opened. Each part oldest first, so whatever has waited
 *            longest is on top.
 *   running  a turn is going right now (purple), in the page's own order.
 *   done     marked done (scripts/session_done.py), or handed on to a
 *            continuation. Ordered by when it finished, so the most recently
 *            finished is last of all.
 *
 * "When it finished" is sessionFilters.finalOutputAt: the handoff for a
 * handed-on session, the closing turn for a done one. "How long it has
 * waited" is `last_at`, the last time it did anything. Nothing else stamps the
 * moment a question was filed.
 *
 * Done stays done through a peer's or a job's turn (routes/observatory.py
 * only clears it on her own message), so a done session that briefly runs
 * again stays down in the done band rather than jumping up.
 *
 * Swarms: the server knows who's running and who asked, but not what she has
 * read (that lives in her browser) nor pending approvals, so a swarm card is
 * coloured here from the SAME roster and the SAME rule as the session cards
 * (sessionFilters). Done and retired members are left off the card and out of
 * its counts, and the card takes its band from the members still at work.
 *
 * Touches: SessionLane.tsx (orders a room with it), SwarmCard.tsx and
 * SwarmPage.tsx (draw a swarm through swarmView), sessionFilters.ts (the
 * colour rule and finalOutputAt), swarmApi.ts (the swarm types).
 *
 * Prompt that produced it: "sessions that are orange float to the top, sorting
 * at the oldest at the top ... remove retired ones from the front page and
 * then make the inactive/done ones grey." · "I want things marked done to all
 * move down to the bottom, in descending order with the most recently retired
 * one last. Above that are the active sessions that are actively running.
 * Above that are ones that needed an input and are usually orange unless I've
 * clicked them."
 */
import type { SessionMeta } from './api';
import { cardState, finalOutputAt, isAsking } from './sessionFilters';
import { swarmState, type MemberState, type Swarm, type SwarmMember } from './swarmApi';

/** The four places a card can stand, top to bottom. `waiting` is split in two
 * so the orange ones lead it. */
export type RoomTier = 'orange' | 'waiting' | 'running' | 'done';

const TIER_RANK: Record<RoomTier, number> = { orange: 0, waiting: 1, running: 2, done: 3 };

/** Is this session finished: marked done, or handed on to a continuation. */
export function isDone(meta: Pick<SessionMeta, 'done_at' | 'retired'>): boolean {
  return meta.retired === true || Boolean(meta.done_at);
}

/** One thing to place in a room: a session row or a swarm, its tier, and the
 * time it's ordered by inside that tier. `at` is ignored for `running`, which
 * keeps the page's order. */
export interface RoomPlace<T> {
  item: T;
  tier: RoomTier;
  at?: string;
}

/** Where a session stands, and the time that orders it there. */
export function sessionPlace(
  meta: SessionMeta,
  openedAt: string | undefined,
  nowMs: number = Date.now(),
): { tier: RoomTier; at?: string } {
  if (isDone(meta)) return { tier: 'done', at: finalOutputAt(meta) ?? meta.done_at };
  if (meta.running) return { tier: 'running' };
  const state = cardState(meta, openedAt, nowMs);
  const orange = state === 'asking' || state === 'error' || state === 'unread';
  return { tier: orange ? 'orange' : 'waiting', at: meta.last_at };
}

/** Stack a room: by tier, then oldest first by `at` (running keeps the order
 * it arrived in). A stable sort, so a poll that changes nothing moves nothing.
 * A card with no readable time goes to the top of its tier: an unknown age is
 * treated as old. */
export function orderRoom<T>(places: RoomPlace<T>[]): T[] {
  const time = (p: RoomPlace<T>) => {
    const ms = Date.parse(p.at ?? '');
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  return places
    .map((place, index) => ({ place, index }))
    .sort((a, b) => {
      const byTier = TIER_RANK[a.place.tier] - TIER_RANK[b.place.tier];
      if (byTier !== 0) return byTier;
      if (a.place.tier !== 'running') {
        const ta = time(a.place);
        const tb = time(b.place);
        if (ta !== tb) return ta < tb ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ place }) => place.item);
}

/** A swarm member as its card draws it: the state from the roster, and
 * whether it wears orange without asking (a reply she hasn't read, or a failed
 * turn), which shows as a grey chip with an orange dot. */
export interface SwarmMemberView extends SwarmMember {
  unread: boolean;
  /** The member's last activity, from the roster, for ordering the chips. */
  lastAt?: string;
}

export interface SwarmView {
  swarm: Swarm;
  /** Members still at work. Done and retired ones are dropped. */
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
    // Leave off finished members, by either account (the swarm list's
    // `retired`, or the roster's done/retired).
    const meta = metaById.get(member.conv);
    if (member.retired || (meta && isDone(meta))) continue;
    let state: MemberState = member.state;
    let unread = false;
    if (meta) {
      state = isAsking(meta) ? 'needs_input' : meta.running ? 'working' : 'silent';
      const paint = cardState(meta, opened[member.conv], nowMs);
      unread = paint === 'unread' || paint === 'error';
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

/** A swarm's members in the room's own order: asking first, then the others
 * waiting on her (dotted ones before plain), then working, each oldest first.
 * What the swarm card's chips follow. */
export function orderMembers(members: SwarmMemberView[]): SwarmMemberView[] {
  return orderRoom(
    members.map((member) => ({
      item: member,
      tier: (member.state === 'working'
        ? 'running'
        : member.state === 'needs_input' || member.unread
          ? 'orange'
          : 'waiting') as RoomTier,
      at: member.lastAt,
    })),
  );
}

/** A swarm's band in its room, from the members still at work: any asking
 * puts it with the orange ones, any working with the running ones, idle ones
 * with the waiting ones. With none left at work it sinks to done. */
export function swarmPlace(view: SwarmView): { tier: RoomTier; at?: string } {
  if (view.members.length === 0) return { tier: 'done' };
  if (view.state === 'needs_input') return { tier: 'orange', at: view.waitingSince };
  if (view.state === 'working') return { tier: 'running' };
  const oldest = view.members
    .map((m) => m.lastAt)
    .filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return { tier: 'waiting', at: oldest };
}
