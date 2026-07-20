/**
 * todoApproval.ts — pure editor→commit mapping for kinds "todo"/"life_todo".
 * Port of openTodoApproval/_approveTodoSubmit (static/js/pending.js): the
 * approval editor mirrors the native add-to-do form and commits through the
 * native POST /api/todos/add so the full field set persists.
 */
import type { AddTodoPayload } from './api';
import type { BuildResult } from './shared';
import { asString } from './shared';
import type { JsonValue } from './types';

export const BUCKETS = ['now', 'up_next', 'later', 'someday'] as const;

/** /api/todos/add resolves the list by its LABEL (find_section_key), not the
 * bucket key — legacy _BUCKET_LABELS. */
export const BUCKET_LABELS: Record<string, string> = {
  now: 'Now',
  up_next: 'Up Next',
  later: 'Later',
  someday: 'Someday',
};

/** Legacy `_BUCKET_LABELS[section] || section` — unknown keys pass through raw. */
export function bucketToLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] || bucket;
}

/** Legacy guard: the native place picker's "+ new place" sentinel never
 * reaches the add endpoint. */
export function normalizePlaceId(placeId: string): string {
  return placeId === '__new__' ? '' : placeId;
}

/** Editor state — one string per form control, exactly like the legacy DOM
 * reads, except `fronts`: a to-do can sit on several fronts at once. */
export interface TodoDraft {
  text: string;
  /** Section LABEL ("Now"/"Up Next"/…) — the value /api/todos/add wants. */
  sectionLabel: string;
  dueBy: string;
  dueTime: string;
  notes: string;
  fronts: string[];
  placeId: string;
  durationMin: string;
}

/** Staged front ids. Current payloads (Rust add-todo tool) carry
 * `fronts: [ids]`; older staged items may still carry the retired single
 * `theme` or `category` string — treat a non-empty one as [that id]. */
function frontsFromPayload(payload: Record<string, JsonValue>): string[] {
  if (Array.isArray(payload.fronts)) {
    return payload.fronts.filter((f): f is string => typeof f === 'string' && f !== '');
  }
  const legacy = asString(payload.theme) || asString(payload.category);
  return legacy ? [legacy] : [];
}

/** Staged payload → initial form state (openTodoApproval's field prefill). */
export function todoDraftFromPayload(payload: Record<string, JsonValue>): TodoDraft {
  return {
    text: asString(payload.text),
    sectionLabel: bucketToLabel(asString(payload.bucket) || 'now'),
    dueBy: asString(payload.due_by),
    dueTime: asString(payload.due_time),
    notes: asString(payload.notes),
    fronts: frontsFromPayload(payload),
    placeId: asString(payload.place_id),
    durationMin: asString(payload.duration_min),
  };
}

/**
 * Form state → the native /api/todos/add body — the exact legacy field
 * mapping from _approveTodoSubmit. Only `duration_min` differs in TYPE: the
 * legacy form posted the raw input string, the React-native editors post a
 * number, and the route accepts both — we follow the React-native convention
 * (omitted when blank).
 */
export function buildTodoAdd(draft: TodoDraft): BuildResult<AddTodoPayload> {
  const text = draft.text.trim();
  if (!text) return { ok: false, error: 'To-do text is required' };
  const body: AddTodoPayload = {
    item: text,
    section: draft.sectionLabel,
    due_by: draft.dueBy,
    notes: draft.notes.trim(),
    due_time: draft.dueTime,
    place_id: normalizePlaceId(draft.placeId),
    fronts: draft.fronts,
  };
  const duration = draft.durationMin.trim();
  if (duration !== '') body.duration_min = Number(duration);
  return { ok: true, value: body };
}

/** Ledger `final` — field-for-field what legacy _approveTodoSubmit logged
 * (`bucket` carries the section LABEL, matching what was committed). */
export function todoFinalForLedger(draft: TodoDraft): Record<string, JsonValue> {
  return {
    text: draft.text.trim(),
    bucket: draft.sectionLabel,
    fronts: draft.fronts,
    due_by: draft.dueBy,
    notes: draft.notes.trim(),
    due_time: draft.dueTime,
    place_id: normalizePlaceId(draft.placeId),
    duration_min: draft.durationMin,
  };
}
