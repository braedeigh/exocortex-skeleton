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
 * `openedAt` comes from the same `exo-bot-opened` map as everything else —
 * passed in, never read here, so openedStore.ts stays the only reader.
 *
 * Prompt that produced it: "buttons on the top right side by color — orange
 * for sessions that are not read, purple at the top for active/running
 * sessions (last used in the past hour), a red one that only appears when
 * there's an error/aborted one".
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

/** Narrow a roster to one bucket. `null` (no filter on) is the identity — the
 * page renders the same list it always did. */
export function applyFilter(
  sessions: SessionMeta[],
  opened: Record<string, string>,
  filter: StateFilter | null,
  nowMs: number = Date.now(),
): SessionMeta[] {
  if (!filter) return sessions;
  return sessions.filter((s) => matchesFilter(s, opened[s.id], filter, nowMs));
}
