/**
 * genericApproval.ts — pure helpers for the GENERIC fallback editor: kinds
 * without a registered native editor render every payload field as an input
 * (bucket → dropdown) and approve through server-side /api/pending/approve.
 * Port of pending.js's _openGenericModal/_fieldRow/_collectPayload.
 */
import { BUCKETS } from './todoApproval';
import type { JsonValue } from './types';

export { BUCKETS };

/** "up_next" → "Up next" (legacy _label). */
export function labelize(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export interface GenericFieldDef {
  key: string;
  label: string;
  /** bucket → the four-key dropdown; number → numeric input re-coerced on
   * collect; text → plain input. Mirrors the legacy dataset.numeric flag. */
  kind: 'bucket' | 'number' | 'text';
  /** Initial input value — '' for null/undefined, JSON for nested values. */
  initial: string;
}

export function genericFieldsFromPayload(payload: Record<string, JsonValue>): GenericFieldDef[] {
  return Object.keys(payload).map((key) => {
    const val = payload[key];
    const kind: GenericFieldDef['kind'] =
      key === 'bucket' ? 'bucket' : typeof val === 'number' ? 'number' : 'text';
    const initial =
      val === null || val === undefined
        ? ''
        : typeof val === 'object'
          ? JSON.stringify(val)
          : String(val);
    return { key, label: labelize(key), kind, initial };
  });
}

/** Current input values → the payload POSTed to /api/pending/approve.
 * Numeric fields coerce back to Number when non-empty (legacy _collectPayload);
 * an emptied numeric field stays '' — also legacy. */
export function collectGenericPayload(
  fields: GenericFieldDef[],
  values: Record<string, string>,
): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {};
  for (const f of fields) {
    const raw = values[f.key] ?? f.initial;
    payload[f.key] = f.kind === 'number' && raw !== '' ? Number(raw) : raw;
  }
  return payload;
}
