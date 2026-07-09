/**
 * reminderDraft.ts — the reminder manager's working-draft model, ported from
 * static/js/reminders.js (window._remindersDraft + saveReminders' coercion).
 * The panel edits a draft; "Save changes" commits the whole registry at once.
 */
import type { ReminderDef, ReminderMode, ReminderSchedule, ReminderShape, TimeOfDay } from '../todos/types';

export const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface ReminderDraft {
  id: string;
  emoji: string;
  label: string;
  type: string;
  color: string;
  shape: ReminderShape;
  schedule: ReminderSchedule;
  every_days: number | '';
  overdue_days: number | '';
  weekdays: number[];
  mode: ReminderMode;
  companion: string;
  times: TimeOfDay[];
  private: boolean;
  due_text: string;
}

/** Seed the draft from live data (reminderManagerPanelHtml's seeding). */
export function seedDrafts(reminders: ReminderDef[] | null | undefined): ReminderDraft[] {
  return (reminders || []).map((r) => ({
    id: r.id || '',
    emoji: r.emoji || '',
    label: r.label || '',
    type: r.type || '',
    color: r.color || '#9AA0B5',
    shape: r.shape || 'circle',
    schedule: r.schedule || 'interval',
    every_days: r.every_days ?? '',
    overdue_days: r.overdue_days ?? '',
    weekdays: Array.isArray(r.weekdays) ? r.weekdays.slice() : [],
    mode: r.mode || 'log',
    companion: r.companion || '',
    times: Array.isArray(r.times) ? r.times.slice() : [],
    private: !!r.private,
    due_text: r.due_text || '',
  }));
}

/** A fresh "+ Add reminder" row (_remAdd's defaults). */
export function newDraft(): ReminderDraft {
  return {
    id: '',
    emoji: '',
    label: '',
    type: '',
    color: '#9AA0B5',
    shape: 'circle',
    schedule: 'interval',
    every_days: 3,
    overdue_days: 7,
    weekdays: [],
    mode: 'log',
    companion: '',
    times: [],
    private: false,
    due_text: '',
  };
}

/** Toggle a weekday (0=Sun..6=Sat), kept numerically sorted (_remToggleWeekday). */
export function toggleWeekday(weekdays: number[], day: number): number[] {
  const wd = weekdays.slice();
  const idx = wd.indexOf(day);
  if (idx === -1) wd.push(day);
  else wd.splice(idx, 1);
  wd.sort((x, y) => x - y);
  return wd;
}

const TIME_ORDER: TimeOfDay[] = ['morning', 'afternoon', 'evening'];

/** Toggle a time-of-day window, kept in canonical order (_remToggleTime). */
export function toggleTime(times: TimeOfDay[], t: TimeOfDay): TimeOfDay[] {
  const ts = times.slice();
  const idx = ts.indexOf(t);
  if (idx === -1) ts.push(t);
  else ts.splice(idx, 1);
  return TIME_ORDER.filter((x) => ts.includes(x));
}

export interface CoercedReminder {
  id?: string;
  emoji: string;
  label: string;
  type?: string;
  color?: string;
  shape: ReminderShape;
  schedule: ReminderSchedule;
  every_days: number;
  overdue_days: number;
  weekdays: number[];
  mode: ReminderMode;
  companion: string;
  times: TimeOfDay[];
  private: boolean;
  due_text: string;
}

/** saveReminders' row coercion: blank labels dropped, numbers defaulted to 1,
 * unknown modes forced to 'log'. */
export function coerceDraftsForSave(drafts: ReminderDraft[]): CoercedReminder[] {
  return drafts
    .filter((r) => (r.label || '').trim())
    .map((r) => ({
      id: r.id || undefined,
      emoji: (r.emoji || '').trim(),
      label: (r.label || '').trim(),
      type: (r.type || '').trim() || undefined,
      color: (r.color || '').trim() || undefined,
      shape: r.shape || 'circle',
      schedule: r.schedule === 'weekly' ? 'weekly' : 'interval',
      every_days: Number(r.every_days) || 1,
      overdue_days: Number(r.overdue_days) || 1,
      weekdays: Array.isArray(r.weekdays) ? r.weekdays : [],
      mode: (['log', 'countdown', 'track'] as ReminderMode[]).includes(r.mode) ? r.mode : 'log',
      companion: (r.companion || '').trim(),
      times: Array.isArray(r.times) ? r.times : [],
      private: !!r.private,
      due_text: (r.due_text || '').trim(),
    }));
}
