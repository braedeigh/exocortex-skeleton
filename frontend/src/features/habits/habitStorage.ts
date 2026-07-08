/**
 * habitStorage.ts — localStorage side of the "Not now" graduation snooze
 * (habitMath.isGradSnoozed is the pure predicate over the map this reads/
 * writes). Key name and map shape match static/js/habits.js's
 * _gradSnoozeMap/snoozeGraduate EXACTLY so a user's existing snoozes
 * (already sitting in their browser) keep working after this rewrite:
 *
 *   localStorage['gradSnooze'] = JSON.stringify({
 *     [habitKey(section, item)]: 'YYYY-MM-DD',   // snoozed until this date
 *   })
 *
 * One deliberate deviation: the old `snoozeGraduate` computes "7 days from
 * now" off `new Date()` (client wall clock). Here it's computed off
 * server_date instead, consistent with the "no wall-clock reads" rule
 * elsewhere in this feature — the two are within hours of each other in
 * practice, so it doesn't change which day the snooze lifts.
 */
import { addDays } from '../todos/todoHelpers';
import { habitKey } from './habitMath';

const GRAD_SNOOZE_KEY = 'gradSnooze';
const SNOOZE_DAYS = 7;

export function readGradSnoozeMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(GRAD_SNOOZE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeGradSnoozeMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(GRAD_SNOOZE_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable (private browsing, quota) — snooze just won't persist
  }
}

/** Hide a graduation nudge for `section`/`item` for a week. */
export function snoozeGraduation(section: string, item: string, serverDate: string): void {
  const map = readGradSnoozeMap();
  map[habitKey(section, item)] = addDays(serverDate, SNOOZE_DAYS);
  writeGradSnoozeMap(map);
}
