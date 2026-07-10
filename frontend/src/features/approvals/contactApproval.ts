/**
 * contactApproval.ts — pure editor→commit mapping for kind "contact".
 * Port of static/js/approvals/contacts.js: the contact-log staging editor,
 * committing through the native POST /api/contacts/log. Undo removes the
 * history entry via POST /api/contacts/history/remove.
 *
 * Payload contract (staged by the contacts cricket, consumed here):
 *   { name, method, date, reason }
 *   name   — contact's display name (must match contacts.json)
 *   method — one of: call, text, facetime, visit
 *   date   — YYYY-MM-DD of the interaction
 *   reason — brief quote from the journal explaining why this was staged
 *            (display-only; never committed)
 */
import type { BuildResult } from './shared';
import { asString } from './shared';
import type { JsonValue } from './types';

export const CONTACT_METHODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'text', label: 'Text' },
  { value: 'facetime', label: 'FaceTime' },
  { value: 'visit', label: 'Visit' },
];

export interface ContactDraft {
  name: string;
  method: string;
  date: string;
}

/** Staged payload → initial form state. Method is lowercased and falls back
 * to "call" when missing/unknown (the legacy select's effective behavior). */
export function contactDraftFromPayload(
  payload: Record<string, JsonValue>,
  fallbackDate: string,
): ContactDraft {
  const method = (asString(payload.method) || 'call').toLowerCase();
  return {
    name: asString(payload.name),
    method: CONTACT_METHODS.some((m) => m.value === method) ? method : 'call',
    date: asString(payload.date) || fallbackDate,
  };
}

/** Form state → the POST /api/contacts/log body. Name is required (legacy
 * focused the name input); the same triple also feeds the undo endpoint. */
export function buildContactLog(
  draft: ContactDraft,
): BuildResult<{ name: string; method: string; date: string }> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  return { ok: true, value: { name, method: draft.method, date: draft.date } };
}
