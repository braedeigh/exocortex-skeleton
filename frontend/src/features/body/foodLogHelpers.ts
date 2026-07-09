/** Pure logic for the Food Log card — port of food.js. */
import type { BodyHealthDay, FoodGuide, SafetyTag } from './types';

/** food_notes is one ';'-separated string per day. */
export function splitFoodNotes(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes
    .split(';')
    .map((f) => f.trim())
    .filter(Boolean);
}

/** Inverse of splitFoodNotes — what /api/food/set stores. */
export function joinFoods(foods: string[]): string {
  return foods.join('; ');
}

export function foodItemsForDate(healthData: BodyHealthDay[] | undefined, date: string): string[] {
  const day = (healthData || []).find((d) => d.date === date);
  return splitFoodNotes(day?.food_notes);
}

/** date ± n days, in pure Y-M-D string math (no local-timezone pitfalls). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1) + days * 86400000);
  return dt.toISOString().slice(0, 10);
}

/**
 * The visible food-log dates: `daysBack` days ago through today (oldest
 * first), skipping anything earlier than the first health-data row — port of
 * renderFoodLog's date loop.
 */
export function foodLogDates(serverDate: string, daysBack: number, earliest: string): string[] {
  const dates: string[] = [];
  for (let i = daysBack; i >= 0; i--) {
    const ds = addDays(serverDate, -i);
    if (ds < earliest) continue;
    dates.push(ds);
  }
  return dates;
}

/** Whether "Show earlier days" has anywhere left to go. */
export function canExpandFoodLog(dates: string[], earliest: string): boolean {
  return dates.length > 0 && dates[0] > earliest;
}

/**
 * Badge color for a logged food. User-set safety tags win over the hardcoded
 * guide; guide matching is substring in either direction — port of food.js
 * foodBadge. Returns '' when unmatched (no badge).
 */
export function foodBadgeColor(
  item: string,
  safetyTags: Record<string, SafetyTag> | undefined,
  guide: FoodGuide | undefined,
): string {
  const lower = item.toLowerCase();
  const tag = (safetyTags || {})[lower];
  if (tag === 'inflammatory') return '#c2185b';
  if (tag === 'suspect') return 'var(--orange)';
  if (tag === 'safe') return 'var(--green)';
  const match = (list: string[] | undefined) =>
    (list || []).some((g) => lower.includes(g) || g.includes(lower));
  if (match(guide?.hurts)) return 'var(--red)';
  if (match(guide?.unsure)) return 'var(--yellow)';
  if (match(guide?.safe)) return 'var(--green)';
  return '';
}

/** "Wed, Jul 9" — past-day row label (food.js used toLocaleDateString). */
export function foodDayLabel(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** "Wednesday, Jul 9" — the day editor's heading label (overview.js). */
export function editorDayLabel(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

/** Replace index `idx` with `value`, or delete it when value is blank —
 * port of saveFoodItemInline ("saving blank = delete"). */
export function replaceFoodItem(foods: string[], idx: number, value: string): string[] {
  const next = foods.slice();
  const val = value.trim();
  if (val) next[idx] = val;
  else next.splice(idx, 1);
  return next;
}

export function removeFoodItem(foods: string[], idx: number): string[] {
  const next = foods.slice();
  next.splice(idx, 1);
  return next;
}
