import { itemFronts } from './todoHelpers';
import type { AddTodoPayload, TodoDetailsPatch } from '../../api/endpoints';
import type { TodoItem } from './types';

/**
 * The staged-form draft behind the (upcoming) unified add/edit to-do modal.
 * A `TodoDraft` holds every field the form lets you touch; nothing commits
 * until Save, at which point `diffDraftForSave` (edit) or `draftToAddPayload`
 * (add) turns it into the wire shape the existing mutations already expect.
 *
 * `place_id` exists on `TodoItem`/`AddTodoPayload` on the backend, but is
 * deliberately left off `TodoDraft` — there's no place picker UI yet, so the
 * draft has nothing to stage for it.
 */
export interface TodoDraft {
  text: string;
  section: string; // ladder label, e.g. 'Now'
  notes: string;
  dueBy: string; // ISO date or ''
  dueTime: string; // 'HH:MM' or ''
  afterDate: string;
  afterId: string;
  fronts: string[];
  durationMin: string; // input-friendly string, '' = none
  // Edit-only — the assignable "actually done" moment (see TodoItem.finished_on).
  finishedOn: string;
  finishedTime: string;
}

/** A fresh draft for the "+ add" flow, opened preset to `section`. `prefill`
 * carries over anything the launch point already knows (e.g. quick-add text
 * or the active focus front — see todoHelpers.withFocusFront). */
export function emptyDraft(
  section: string,
  prefill?: { text?: string; dueBy?: string; fronts?: string[] },
): TodoDraft {
  return {
    text: prefill?.text ?? '',
    section,
    notes: '',
    dueBy: prefill?.dueBy ?? '',
    dueTime: '',
    afterDate: '',
    afterId: '',
    fronts: prefill?.fronts ?? [],
    durationMin: '',
    finishedOn: '',
    finishedTime: '',
  };
}

/** A draft seeded from an existing item, for the edit flow — mirrors the old
 * per-item editor's init effect (null/undefined fields normalize to ''/[]). */
export function draftFromItem(item: TodoItem, section: string): TodoDraft {
  return {
    text: item.text,
    section,
    notes: item.notes || '',
    dueBy: item.due_by || '',
    dueTime: item.due_time || '',
    afterDate: item.after_date || '',
    afterId: item.after_id || '',
    fronts: itemFronts(item),
    durationMin: item.duration_min ? String(item.duration_min) : '',
    finishedOn: item.finished_on || '',
    finishedTime: item.finished_time || '',
  };
}

/** Parse the duration input into a positive minute count, or null when the
 * field is blank / not a usable positive number ("cleared"). */
function parseDurationInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Order-insensitive set equality for front-id lists. */
function sameFrontSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((f) => setB.has(f));
}

/** Build the POST /api/todos/add payload from a draft — same spirit as the
 * old per-section add sheet's submit, but staging the full field set the
 * draft supports.
 * Optional keys are included only when they carry a value after trim, so
 * the request mirrors what a user actually typed rather than sending a wall
 * of empty strings. */
export function draftToAddPayload(draft: TodoDraft): AddTodoPayload {
  const payload: AddTodoPayload = {
    item: draft.text.trim(),
    section: draft.section,
  };
  const dueBy = draft.dueBy.trim();
  if (dueBy) payload.due_by = dueBy;
  const dueTime = draft.dueTime.trim();
  if (dueTime) payload.due_time = dueTime;
  const notes = draft.notes.trim();
  if (notes) payload.notes = notes;
  const afterDate = draft.afterDate.trim();
  if (afterDate) payload.after_date = afterDate;
  const afterId = draft.afterId.trim();
  if (afterId) payload.after_id = afterId;
  if (draft.fronts.length > 0) payload.fronts = draft.fronts;
  const duration = parseDurationInput(draft.durationMin);
  if (duration !== null) payload.duration_min = duration;
  // finishedOn/finishedTime are deliberately excluded here — "actually done"
  // only makes sense for an edit on an already-done item, never at add time.
  return payload;
}

export interface TodoDraftDiff {
  /** The new title, only present when it actually changed (and isn't blank). */
  newText?: string;
  /** Only the details keys that changed vs. `base` — the /api/todos/details
   * endpoint only touches keys present in the payload, so untouched fields
   * must be omitted rather than resent unchanged. */
  patch: TodoDetailsPatch;
  /** Present only when the section changed. */
  moveTo?: string;
}

/**
 * Diff a draft against the item (and section) it started from, producing
 * exactly what Save needs to send: a rename, a details patch, and/or a move
 * — each field included only when it changed. Null/undefined base fields
 * normalize to '' (or [] for fronts) before comparing, so a field the draft
 * never touched never shows up as a spurious patch key.
 *
 * Field-clearing follows /api/todos/details' own contract (routes/todos.py):
 * an empty string pops a string key, an empty `fronts` array clears fronts,
 * and `duration_min: 0` pops duration — so a "changed to cleared" field is
 * sent as '' (or 0 for duration), not omitted.
 */
export function diffDraftForSave(draft: TodoDraft, base: TodoItem, baseSection: string): TodoDraftDiff {
  const patch: TodoDetailsPatch = {};

  const trimmedText = draft.text.trim();
  const newText = trimmedText && trimmedText !== base.text ? trimmedText : undefined;

  const baseNotes = base.notes ?? '';
  if (draft.notes !== baseNotes) patch.notes = draft.notes;

  const baseDueBy = base.due_by ?? '';
  if (draft.dueBy !== baseDueBy) patch.due_by = draft.dueBy;

  const baseDueTime = base.due_time ?? '';
  if (draft.dueTime !== baseDueTime) patch.due_time = draft.dueTime;

  const baseAfterDate = base.after_date ?? '';
  if (draft.afterDate !== baseAfterDate) patch.after_date = draft.afterDate;

  const baseAfterId = base.after_id ?? '';
  if (draft.afterId !== baseAfterId) patch.after_id = draft.afterId;

  const baseFronts = itemFronts(base);
  if (!sameFrontSet(draft.fronts, baseFronts)) patch.fronts = draft.fronts;

  const baseDuration = base.duration_min && base.duration_min > 0 ? base.duration_min : null;
  const draftDuration = parseDurationInput(draft.durationMin);
  if (draftDuration !== baseDuration) patch.duration_min = draftDuration ?? 0;

  const baseFinishedOn = base.finished_on ?? '';
  if (draft.finishedOn !== baseFinishedOn) patch.finished_on = draft.finishedOn;

  const baseFinishedTime = base.finished_time ?? '';
  if (draft.finishedTime !== baseFinishedTime) patch.finished_time = draft.finishedTime;

  const moveTo = draft.section !== baseSection ? draft.section : undefined;

  const diff: TodoDraftDiff = { patch };
  if (newText !== undefined) diff.newText = newText;
  if (moveTo !== undefined) diff.moveTo = moveTo;
  return diff;
}
