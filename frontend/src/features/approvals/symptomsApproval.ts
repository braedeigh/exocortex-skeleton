/**
 * symptomsApproval.ts — pure editor→commit mapping for kind "symptoms".
 * Port of static/js/approvals/long-covid.js: the long-COVID symptom staging
 * editor (0–3 per field + histamine flare), committing through the native
 * POST /api/symptoms.
 *
 * Payload contract (staged by the long-covid cricket, consumed here):
 *   { date, ...only the symptom fields that had signal }
 *   nose_congestion/brain_fog/abdominal_pain/hand_pain/headache/energy — 0–3
 *   histamine_flare — "yes" | "no"
 *   flare_trigger   — free text, only present if histamine_flare is "yes"
 *
 * Undo:
 *   Prior row for the date → re-POST its old values (real reversal).
 *   No prior row → reopen this editor (best-effort; /api/symptoms has no
 *   DELETE, so a newly created row can't be erased cleanly).
 */
import type { HealthDay } from '../todos/types';
import type { SymptomWriteValues } from './api';
import type { BuildResult } from './shared';
import { asString } from './shared';
import type { JsonValue } from './types';

/**
 * Column key + label — the cricket's payload contract (_LC_SYM_FIELDS).
 * Deliberately a local copy, NOT imported from features/todos/symptomHelpers:
 * this list is pinned to what the cricket stages, not to whatever the native
 * symptom card evolves into.
 */
export const SYMPTOM_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'nose_congestion', label: 'Nose Congestion' },
  { key: 'brain_fog', label: 'Brain Fog' },
  { key: 'abdominal_pain', label: 'Abdominal Pain' },
  { key: 'hand_pain', label: 'Hand Pain' },
  { key: 'headache', label: 'Headache' },
  { key: 'energy', label: 'Energy' },
];

export const SYMPTOM_LEVELS = [0, 1, 2, 3] as const;

export interface SymptomsDraft {
  date: string;
  /** Only fields with a selection have a key — unselected fields are ABSENT
   * and stay out of the commit (the legacy only-if-selected behavior). */
  levels: Record<string, number>;
  flare: 'yes' | 'no';
  trigger: string;
}

/** Staged payload → initial form state: preselect only the fields the
 * cricket sent (legacy `pre` button marking); flare defaults to "no". */
export function symptomsDraftFromPayload(
  payload: Record<string, JsonValue>,
  fallbackDate: string,
): SymptomsDraft {
  const levels: Record<string, number> = {};
  for (const f of SYMPTOM_FIELDS) {
    const v = payload[f.key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) levels[f.key] = n;
  }
  return {
    date: asString(payload.date) || fallbackDate,
    levels,
    flare: payload.histamine_flare === 'yes' ? 'yes' : 'no',
    trigger: asString(payload.flare_trigger),
  };
}

/**
 * Form state → the POST /api/symptoms body (_lcApproveSubmit's collection):
 * only selected 0–3 fields are included; histamine_flare is ALWAYS included;
 * flare_trigger only when non-empty.
 */
export function buildSymptomsLog(
  draft: SymptomsDraft,
): BuildResult<{ date: string; symptoms: SymptomWriteValues }> {
  const date = draft.date.trim();
  if (!date) return { ok: false, error: 'Date is required' };
  const symptoms: SymptomWriteValues = {};
  for (const f of SYMPTOM_FIELDS) {
    const v = draft.levels[f.key];
    if (v !== undefined) symptoms[f.key] = v;
  }
  symptoms.histamine_flare = draft.flare;
  const trigger = draft.trigger.trim();
  if (trigger) symptoms.flare_trigger = trigger;
  return { ok: true, value: { date, symptoms } };
}

/**
 * Old values to re-POST for a real undo, or null when no prior row existed
 * (caller falls back to the reopen-editor undo). Keeps the legacy column set:
 * the six 0–3 fields + histamine_flare + flare_trigger + nose_spray, dropping
 * empty/null values. Note (legacy-faithful): re-POSTing only SETS these
 * columns — a column newly written by the approval that had no prior value
 * is not cleared.
 */
export function symptomsUndoValues(prevRow: HealthDay | null): SymptomWriteValues | null {
  if (!prevRow) return null;
  const cols = [
    ...SYMPTOM_FIELDS.map((f) => f.key),
    'histamine_flare',
    'flare_trigger',
    'nose_spray',
  ];
  const old: SymptomWriteValues = {};
  for (const col of cols) {
    const v = prevRow[col];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' || typeof v === 'string') old[col] = v;
  }
  return old;
}
