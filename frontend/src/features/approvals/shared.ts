/**
 * shared.ts — tiny pure utilities every per-kind approval helper leans on.
 * Kept separate from the editors so they're trivially unit-testable.
 */
import type { HealthDay } from '../todos/types';
import type { JsonValue, PendingChange } from './types';

/** Validation-aware result from the pure payload builders. */
export type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * `change.payload` as a record. Every staged payload today is a JSON object;
 * anything else (null, array, scalar) reads as an empty record so editors
 * degrade to blank fields instead of crashing.
 */
export function payloadRecord(change: Pick<PendingChange, 'payload'>): Record<string, JsonValue> {
  const p = change.payload;
  if (p && typeof p === 'object' && !Array.isArray(p)) return p;
  return {};
}

/** Loose string coercion matching the legacy editors' `p.field || ''` reads. */
export function asString(v: JsonValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Today as YYYY-MM-DD. Deliberately the legacy idiom
 * (`new Date().toISOString().slice(0, 10)`, i.e. UTC) so date defaults stay
 * byte-identical with what the old approval editors produced.
 */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The health row for a date, if the dashboard snapshot has one — the React
 * stand-in for the legacy `window.D.health_data.find(...)` undo snapshots. */
export function findHealthRow(
  healthData: HealthDay[] | undefined,
  date: string,
): HealthDay | null {
  return (healthData || []).find((d) => d.date === date) ?? null;
}
