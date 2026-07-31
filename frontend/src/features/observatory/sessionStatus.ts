/**
 * sessionStatus.ts — the small pure bits of a session card's text: how long ago
 * it last did anything, and the housekeeping line that stamp sits in. Used by
 * the Observatory cards and by the terrain map's agent hovercard, so they live
 * on their own rather than inside either.
 *
 * It used to also hold a sessionStatus() that answered "busy / ready / idle".
 * That question now belongs to sessionFilters.ts, where the rail's coloured
 * buttons ask it — two functions defining "unread" was one too many, and the
 * card and the button have to agree.
 */
import type { SessionMeta } from './api';
import { formatSessionSpend } from './turnStats';

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

/**
 * The card's one quiet line of housekeeping: "opus[1m] · 4m ago · 18.2k tokens
 * · $4.21". Built from whichever parts exist, so a fresh session shows nothing
 * rather than a row of blanks and separators, and recomputed per render, which
 * is what keeps the "4m ago" honest as the roster polls.
 *
 * The model leads it. `model_effective` is the resolved answer — the session's
 * own pin if it has one, otherwise the CLI default the server looked up — so it
 * reads as "what it runs on" and not "what she happened to override", which for
 * most sessions would be nothing at all.
 *
 * Lives here, next to the stamp it prints, because BOTH the Observatory's
 * roster card (SessionLane) and the terrain map's agent hovercard
 * (AgentHoverCard) draw this exact line. Two copies of it drifted apart the
 * moment one of them wanted a fourth field.
 */
export function cardMetaLine(meta: SessionMeta | undefined): string {
  if (!meta) return '';
  return [
    meta.model_effective ?? null,
    lastActivityLabel(meta.last_at),
    meta.tokens ? formatSessionSpend(meta.tokens) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
