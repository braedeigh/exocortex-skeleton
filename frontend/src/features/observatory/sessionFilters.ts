/**
 * sessionFilters.ts — the three coloured buttons on the Observatory's
 * top-right rail, as pure predicates so the counts and the filtering can't
 * disagree.
 *
 * The three colours are the ones the cards already wear (Orchestra.module.css):
 *
 *   purple  ACTIVE  — a turn is running now, or it did anything in the last hour
 *   orange  UNREAD  — output she hasn't opened, or a session stopped to ask her
 *   red     ERROR   — the last turn ended in failure / was aborted
 *
 * NOT a partition. A card wears ONE state (broken beats busy beats unread —
 * see SessionLane), but a session can honestly belong to two of these buckets
 * at once: a session that replied five minutes ago is both active and unread.
 * These buttons answer "show me all the X", so a session is counted under
 * every bucket it truly matches. Making them exclusive would empty the orange
 * button exactly when it matters most, because purple would have eaten it.
 *
 * The CARDS read from here too — cardState() below picks which of these three a
 * card wears, so a colour on the rail and the same colour on a card always mean
 * the identical thing. That tie is the point: the rule lives in one place.
 *
 * `openedAt` comes from the same `exo-bot-opened` map as everything else —
 * passed in, never read here, so openedStore.ts stays the only reader.
 *
 * Prompt that produced it: "buttons on the top right side by color — orange
 * for sessions that are not read, purple at the top for active/running
 * sessions (last used in the past hour), a red one that only appears when
 * there's an error/aborted one"; "you can press more than one at a time".
 */
import type { SessionMeta } from './api';
import { isUnread } from './openedStore';

export type StateFilter = 'active' | 'unread' | 'error';

/** "Last used in the past hour" — her words, and the whole definition of the
 * purple button's idle half. */
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

export function matchesFilter(
  meta: SessionMeta,
  openedAt: string | undefined,
  filter: StateFilter,
  nowMs: number = Date.now(),
): boolean {
  switch (filter) {
    case 'active': {
      // Running is the server's already-staleness-corrected value, so it wins
      // outright and needs no clock. Otherwise: did it do anything recently?
      // last_at moves on both her send and the turn's finish, which is exactly
      // "last used". Date.parse, not string maths — the server stamps zoneless
      // local time while other stamps here are UTC-with-Z (same reasoning as
      // isUnread).
      if (meta.running === true) return true;
      const last = Date.parse(meta.last_at ?? '');
      if (Number.isNaN(last)) return false;
      return nowMs - last <= ACTIVE_WINDOW_MS;
    }
    case 'unread':
      // A session that stopped to ask counts as unread even if she has opened
      // it since: the ask is still standing there unanswered.
      if (meta.awaiting_input || meta.awaiting_approval) return true;
      return isUnread(meta.last_at, openedAt);
    case 'error':
      return typeof meta.last_error === 'string' && meta.last_error !== '';
  }
}

/** What a card WEARS. Same three predicates as the buttons, read in precedence
 * order — so the rail and the cards can never drift apart, and "active in the
 * last hour" is written down exactly once (change ACTIVE_WINDOW_MS and both the
 * purple button's count and the purple dots move together).
 *
 *   error    red     the last turn failed — broken beats everything
 *   running  purple  a turn is going right now; the card breathes
 *   unread   orange  she hasn't read it, or it stopped to ask — her move
 *   recent   purple  used inside the hour but idle and read — warm, still
 *   rest     grey    cold
 *
 * ONE state per card, because a card can honestly be several of these at once
 * and stacking their glows would just muddy all of them. The order is by
 * urgency: what's broken beats what's busy beats what wants her.
 *
 * `recent` is the rung that was missing. The purple button counted these and
 * the card showed them grey — so the rail said "3 active" and the roster looked
 * dead. Steady purple, not the running card's breath: breath means a turn is
 * moving RIGHT NOW, and a session that merely ran twenty minutes ago isn't
 * moving. Two truths, two treatments.
 *
 * Prompt that produced it: "make the dots on the cards that are active and
 * activated by the filter, like active within the last hour, glow purple also
 * on the cards and tied together procedurally".
 */
export type CardState = 'error' | 'running' | 'unread' | 'recent' | 'rest';

export function cardState(
  meta: SessionMeta,
  openedAt: string | undefined,
  nowMs: number = Date.now(),
): CardState {
  if (matchesFilter(meta, openedAt, 'error', nowMs)) return 'error';
  if (meta.running === true) return 'running';
  if (matchesFilter(meta, openedAt, 'unread', nowMs)) return 'unread';
  // Everything the purple button counts EXCEPT the running half, which already
  // has its own louder state above.
  if (matchesFilter(meta, openedAt, 'active', nowMs)) return 'recent';
  return 'rest';
}

/** How many sessions sit under each button — the number on its face, and (for
 * red) whether it's drawn at all. */
export function filterCounts(
  sessions: SessionMeta[],
  opened: Record<string, string>,
  nowMs: number = Date.now(),
): Record<StateFilter, number> {
  const counts: Record<StateFilter, number> = { active: 0, unread: 0, error: 0 };
  for (const s of sessions) {
    for (const key of ['active', 'unread', 'error'] as StateFilter[]) {
      if (matchesFilter(s, opened[s.id], key, nowMs)) counts[key] += 1;
    }
  }
  return counts;
}

/** Narrow a roster to the buttons she has pressed. More than one can be down at
 * a time, and they UNION: purple + orange means "show me what's alive AND what
 * I haven't read", not the sliver that's both. Intersecting would make the
 * second tap subtract, which is the opposite of what pressing another colour
 * looks like it should do — and since the buckets already overlap, most pairs
 * would land on almost nothing.
 *
 * No buttons down is the identity — the page renders the same list it always
 * did, and returns the very same array so React sees no change.
 *
 * Prompt that produced it: "you can press more than one at a time". */
export function applyFilter(
  sessions: SessionMeta[],
  opened: Record<string, string>,
  filters: StateFilter[],
  nowMs: number = Date.now(),
): SessionMeta[] {
  if (filters.length === 0) return sessions;
  return sessions.filter((s) =>
    filters.some((f) => matchesFilter(s, opened[s.id], f, nowMs)),
  );
}
