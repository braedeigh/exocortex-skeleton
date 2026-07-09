/** Pure cache updaters for the Body tab's optimistic mutations — each takes
 * the polled BodyData and returns a new one, mirroring what the server will
 * persist so the UI lands instantly (the old page's local re-render habit). */
import type { BodyData, BodyHealthDay, SafetyTag } from './types';

function shortDateFor(date: string): string {
  const dt = new Date(date + 'T12:00:00');
  if (Number.isNaN(dt.getTime())) return date;
  const month = dt.toLocaleDateString('en-US', { month: 'short' });
  return `${month} ${String(dt.getDate()).padStart(2, '0')}`;
}

function upsertHealthDay(
  data: BodyData,
  date: string,
  patch: (day: BodyHealthDay) => BodyHealthDay,
): BodyData {
  const rows = data.health_data || [];
  const exists = rows.some((d) => d.date === date);
  let next: BodyHealthDay[];
  if (exists) {
    next = rows.map((d) => (d.date === date ? patch({ ...d }) : d));
  } else {
    const fresh = patch({
      date,
      date_short: shortDateFor(date),
      day_name: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
    });
    next = [...rows, fresh].sort((a, b) => a.date.localeCompare(b.date));
  }
  return { ...data, health_data: next };
}

/** Apply a numeric /api/symptoms payload to the day's row (nose_spray 0/1
 * becomes the boolean the GET returns). */
export function applySymptoms(data: BodyData, date: string, symptoms: Record<string, number>): BodyData {
  return upsertHealthDay(data, date, (day) => {
    const next = { ...day };
    for (const [col, val] of Object.entries(symptoms)) {
      if (col === 'nose_spray') next.nose_spray = val === 1;
      else next[col] = val;
    }
    return next;
  });
}

/** Replace a day's food_notes (the /api/food/set contract). */
export function applyFoodNotes(data: BodyData, date: string, foodNotes: string): BodyData {
  return upsertHealthDay(data, date, (day) => ({ ...day, food_notes: foodNotes || null }));
}

/** Append one food to a day's notes (the /api/food/log contract). */
export function applyFoodAppend(data: BodyData, date: string, food: string): BodyData {
  return upsertHealthDay(data, date, (day) => {
    const existing = (day.food_notes || '').trim();
    return { ...day, food_notes: existing ? `${existing}; ${food}` : food };
  });
}

/** Set or clear ('' clears) a food's safety tag, keyed lowercase. */
export function applySafetyTag(data: BodyData, name: string, tag: SafetyTag | ''): BodyData {
  const tags = { ...(data.kitchen_safety_tags || {}) };
  const key = name.toLowerCase();
  if (tag) tags[key] = tag;
  else delete tags[key];
  return { ...data, kitchen_safety_tags: tags };
}

export function applyQueue(data: BodyData, queue: string[]): BodyData {
  return { ...data, food_test_queue: queue };
}
