/**
 * todoDoneApproval.ts — pure helpers for kind "todo_done": the todos-closer
 * cricket's nomination that a journal card closes an open to-do. The editor is
 * a read-only confirmation (the payload is evidence, not a form): the item's
 * text, her verbatim quote, and the card moment it came from. Commit goes
 * server-side through /api/pending/approve — routes/pending.py re-verifies the
 * quote against the card on disk before anything is written.
 *
 * Payload contract (staged by prompts/crickets/todos-closer.md):
 *   { id, text, card_id, quote }
 *   id      — the to-do's stable id (identity; text is the legacy fallback)
 *   text    — the to-do's text, for display
 *   card_id — stream-pool card id, e.g. "2026-08-12.2142b"
 *   quote   — her line from that card, copied verbatim
 */
import { asString, payloadRecord } from './shared';
import type { PendingChange } from './types';

export interface TodoDoneDraft {
  todoId: string;
  text: string;
  cardId: string;
  quote: string;
}

export function todoDoneFromChange(change: Pick<PendingChange, 'payload'>): TodoDoneDraft {
  const p = payloadRecord(change);
  return {
    todoId: asString(p.id),
    text: asString(p.text),
    cardId: asString(p.card_id),
    quote: asString(p.quote),
  };
}

/** "2026-08-12.2142b" → "2026-08-12 · 21:42" (the card id carries the minute).
 * Malformed ids render as themselves rather than a wrong-looking moment. */
export function cardMoment(cardId: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})\.(\d{2})(\d{2})[a-z]/.exec(cardId);
  if (!m) return cardId;
  return `${m[1]} · ${m[2]}:${m[3]}`;
}
