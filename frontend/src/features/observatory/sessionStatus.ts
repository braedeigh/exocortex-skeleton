/**
 * sessionStatus.ts — one small pure helper: how long ago a session last did
 * anything, in words. Used on the Observatory cards and on the terrain hover
 * card, so it lives on its own rather than inside either.
 *
 * It used to also hold a sessionStatus() that answered "busy / ready / idle".
 * That question now belongs to sessionFilters.ts, where the rail's coloured
 * buttons ask it — two functions defining "unread" was one too many, and the
 * card and the button have to agree.
 */

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
