/**
 * api.ts — every endpoint the approvals feature talks to.
 *
 * Two families, mirroring the legacy split:
 *  - the QUEUE endpoints (routes/pending.py): poll, deny/dequeue, and the
 *    server-side approve used only by the generic fallback editor;
 *  - the NATIVE commit endpoints each per-kind editor writes through, so an
 *    approved change lands exactly like a hand-entered one.
 *
 * Endpoints that already exist in src/api/endpoints.ts are re-exported from
 * there; the rest are defined here (this feature owns them for now).
 */
import { api } from '../../api/client';
import { addTodo, getTodayData, removeTodo } from '../../api/endpoints';
import type { AddTodoPayload, AddTodoResponse, OkResponse } from '../../api/endpoints';
import type { JsonValue, PendingQueue } from './types';

// ── Queue (routes/pending.py) ────────────────────────────────────────────────

export function getPendingQueue(signal?: AbortSignal): Promise<PendingQueue> {
  return api.get('/api/pending', signal);
}

/** Drop a staged item from the queue — after a successful native commit, or a
 * Deny (legacy ApprovalKit.removeFromQueue). */
export function denyPending(id: string): Promise<OkResponse> {
  return api.post('/api/pending/deny', { id });
}

/**
 * Server-side commit + dequeue in one call (routes/pending.py::_commit) —
 * only the GENERIC fallback editor uses this; kinds with a native editor
 * commit through their own endpoint and then denyPending() the entry.
 * `payload` carries the user's edits, merged over the staged payload.
 */
export function approvePendingServerSide(
  id: string,
  payload: Record<string, JsonValue>,
): Promise<OkResponse> {
  return api.post('/api/pending/approve', { id, payload });
}

// ── Decisions ledger (routes/decisions.py) ──────────────────────────────────

export interface DecisionEntry {
  action: 'approve' | 'deny';
  kind: string;
  /** Payload exactly as the cricket staged it. */
  proposed: JsonValue | null;
  /** What the user kept — approve only; null on deny. */
  final: Record<string, JsonValue> | null;
}

/**
 * Best-effort append to data/decisions.jsonl. Never throws — the learning
 * signal must never block a decision (legacy ApprovalKit.logDecision). The
 * `edited` flag is computed authoritatively server-side.
 */
export async function logDecision(entry: DecisionEntry): Promise<void> {
  try {
    await api.post('/api/decisions/log', {
      action: entry.action,
      kind: entry.kind,
      proposed: entry.proposed ?? null,
      final: entry.final ?? null,
    });
  } catch {
    // logging never blocks a decision
  }
}

// ── Native commit endpoints ──────────────────────────────────────────────────

/** Replace (not append) a date's food notes — routes/health.py set_food. */
export function setFood(date: string, food_notes: string): Promise<OkResponse> {
  return api.post('/api/food/set', { date, food_notes });
}

/**
 * Symptom columns for a date — routes/health.py log_symptoms. Values are
 * numbers for the 0–3 fields but STRINGS for histamine_flare ("yes"/"no")
 * and flare_trigger, so this is deliberately looser than the Body tab's
 * SymptomPayload (bodyApi.ts, Record<string, number>).
 */
export type SymptomWriteValues = Record<string, number | string>;

export function postSymptoms(date: string, symptoms: SymptomWriteValues): Promise<OkResponse> {
  return api.post('/api/symptoms', { date, symptoms });
}

/** Log an interaction — routes/health.py log_contact. */
export function logContact(name: string, method: string, date: string): Promise<OkResponse> {
  return api.post('/api/contacts/log', { name, method, date });
}

/** Undo for logContact — routes/health.py remove_contact_history. */
export function removeContactHistory(
  name: string,
  date: string,
  method: string,
): Promise<OkResponse> {
  return api.post('/api/contacts/history/remove', { name, date, method });
}

// Native endpoints already defined in src/api/endpoints.ts, re-exported so
// the whole commit surface of this feature reads from one module:
export { addTodo, getTodayData, removeTodo };
export type { AddTodoPayload, AddTodoResponse, OkResponse };
