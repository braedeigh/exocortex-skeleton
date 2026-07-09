/**
 * carMath.ts — pure logic ported from static/js/car.js: type labels, the
 * due-soon date math and its color thresholds, next_due sorting, plus the
 * optimistic cache updaters for the /api/data/car query. All side-effect
 * free — tested in carMath.test.ts.
 */

import type { AddCarEntryPayload } from './api';
import type { CarData, CarEntry } from './types';

const CAR_TYPE_LABELS: Record<string, string> = {
  oil_change: 'Oil change',
  brake_pads: 'Brake pads',
  registration: 'Registration',
};

/** Known types get their canonical label; custom snake_case types are
 * humanized ("tire_rotation" → "Tire Rotation"); empty → em dash. */
export function carTypeLabel(t: string | null | undefined): string {
  if (t && CAR_TYPE_LABELS[t]) return CAR_TYPE_LABELS[t];
  if (!t) return '—';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Whole days from `today` to `dateStr` (both ISO YYYY-MM-DD): negative =
 * past due, 0 = due today. Null when either date is missing/invalid. */
export function daysUntil(dateStr: string | null | undefined, today: string): number | null {
  if (!dateStr) return null;
  const d = Date.parse(`${dateStr}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(t)) return null;
  return Math.floor((d - t) / 86400000);
}

/** Old car.js coloring: overdue (red) below 0 days, "soon" (orange) at 30
 * days or less, otherwise unstyled. */
export type DueTone = 'overdue' | 'soon' | null;

export function dueTone(days: number | null): DueTone {
  if (days === null) return null;
  if (days < 0) return 'overdue';
  if (days <= 30) return 'soon';
  return null;
}

/** Soonest next_due first; entries with no next_due sort last ('9999-12-31'
 * sentinel, same as the old table). Stable copy — input untouched. */
export function sortEntriesByNextDue(entries: readonly CarEntry[]): CarEntry[] {
  return entries.slice().sort((a, b) => {
    const av = a.next_due || '9999-12-31';
    const bv = b.next_due || '9999-12-31';
    return av.localeCompare(bv);
  });
}

/** Local YYYY-MM-DD — the old carDaysUntil measured against the client's
 * midnight, not the server's. */
export function localTodayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Build the entry the server will create from a form payload — mirrors
 * routes/car.py add_car_entry so the optimistic row matches the real one. */
export function normalizeNewEntry(payload: AddCarEntryPayload, id: string): CarEntry {
  return {
    id,
    type: payload.type.trim() || 'other',
    date: payload.date.trim() || null,
    mileage: payload.mileage === '' ? null : payload.mileage,
    notes: payload.notes.trim(),
    next_due: payload.next_due.trim() || null,
  };
}

// ---- optimistic cache updaters (pure: return new objects) ----

function entriesOf(data: CarData): CarEntry[] {
  return Array.isArray(data.car_maintenance?.entries) ? data.car_maintenance.entries : [];
}

export function applyEntryAdd(data: CarData, entry: CarEntry): CarData {
  return {
    ...data,
    car_maintenance: { ...data.car_maintenance, entries: [...entriesOf(data), entry] },
  };
}

export function applyEntryRemove(data: CarData, id: string): CarData {
  return {
    ...data,
    car_maintenance: {
      ...data.car_maintenance,
      entries: entriesOf(data).filter((e) => e.id !== id),
    },
  };
}

export function applyNotesText(data: CarData, text: string): CarData {
  return { ...data, car_notes: { ...data.car_notes, text } };
}
