/**
 * sessionStatus.ts — the roster's status dot, one source of truth for three
 * things she can't otherwise tell at a glance: a turn is running server-side
 * (busy), it finished with activity she hasn't opened yet (ready), or there's
 * nothing new (idle). `openedAt` is read from the same `exo-bot-opened`
 * localStorage map RosterPage's unread accent already uses
 * (markConversationOpened in openedStore.ts writes it) — this doesn't
 * read storage itself so the roster stays the only place that touches it.
 */

export type SessionStatus = 'busy' | 'ready' | 'idle';

export interface SessionStatusMeta {
  running?: boolean;
  last_at?: string;
}

export function sessionStatus(meta: SessionStatusMeta, openedAt: string | undefined): SessionStatus {
  // A `running` flag here is already the server's effective value (routes/
  // observatory.py resolves staleness before this ever reaches the client)
  // — busy wins outright, regardless of last_at.
  if (meta.running) return 'busy';

  if (!meta.last_at) return 'idle';
  const last = Date.parse(meta.last_at);
  if (Number.isNaN(last)) return 'idle';

  if (!openedAt) return 'ready'; // never opened, but something's there
  const seen = Date.parse(openedAt);
  if (Number.isNaN(seen)) return 'ready';

  return last > seen ? 'ready' : 'idle';
}

/**
 * "When did this session last do anything" — the card's activity stamp.
 *
 * `last_at` is exactly the right field for it: the server stamps it BOTH when
 * a send starts (her input) and when the turn finishes (its output), so it
 * already means "last input or output" without any new bookkeeping.
 *
 * Date.parse, not string maths: the server stamps zoneless local time and
 * other stamps in this app are UTC-with-Z, which are lexically incomparable
 * but land on the same clock once parsed (same reasoning as isUnread).
 *
 * A future timestamp (clock skew between the box and her phone) clamps to
 * "just now" rather than printing a negative age.
 *
 * Prompt that produced it: "i also want in the sessions display for each to
 * have the last time it had an input or output displayed".
 */
export function lastActivityLabel(lastAt: unknown, nowMs: number = Date.now()): string | null {
  if (typeof lastAt !== 'string' || !lastAt) return null;
  const then = Date.parse(lastAt);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, (nowMs - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)}d ago`;
  return `${Math.round(seconds / (86400 * 30))}mo ago`;
}
