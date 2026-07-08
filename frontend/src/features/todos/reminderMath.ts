import type { ActivityEntry, ReminderDef, TimeOfDay } from './types';

export type ReminderTone = 'red' | 'orange' | 'ongoing';

export interface ReminderState {
  show: boolean;
  tone?: ReminderTone;
  sub?: string;
  daysText?: string;
  overdue?: boolean;
  pulse?: boolean;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function lastScheduled(weekdays: number[], ref: Date): Date | null {
  for (let i = 0; i < 7; i++) {
    const d = shiftDate(ref, -i);
    if (weekdays.includes(d.getDay())) return d;
  }
  return null;
}

function nextScheduled(weekdays: number[], ref: Date): Date | null {
  for (let i = 0; i < 7; i++) {
    const d = shiftDate(ref, i);
    if (weekdays.includes(d.getDay())) return d;
  }
  return null;
}

export function daysSince(entries: ActivityEntry[], type: string, todayISO: string): number | null {
  const matches = entries.filter((e) => e.type === type);
  if (!matches.length) return null;
  const lastDate = matches.reduce((max, e) => (e.date > max ? e.date : max), matches[0].date);
  const today = parseDate(todayISO);
  const d = parseDate(lastDate);
  return Math.floor((today.getTime() - d.getTime()) / 86400000);
}

function daysText(days: number | null): string {
  if (days === null) return 'never logged';
  if (days === 0) return 'today';
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

export function computeReminderState(r: ReminderDef, entries: ActivityEntry[], todayISO: string): ReminderState {
  if (r.mode === 'track') return { show: false };

  const mode = r.mode || 'log';
  const days = daysSince(entries, r.type, todayISO);
  const dText = daysText(days);
  const schedule = r.schedule || 'interval';
  const dueText = (r.due_text || '').trim();

  if (schedule === 'weekly') {
    const weekdays = r.weekdays || [];
    if (!weekdays.length) return { show: false };
    const today = parseDate(todayISO);
    const last = lastScheduled(weekdays, today);
    if (!last) return { show: false };
    const lastStr = fmtDate(last);
    const loggedSince = entries.some((e) => e.type === r.type && e.date >= lastStr);
    const due = !loggedSince;
    const isToday = lastStr === fmtDate(today);
    const overdue = due && !isToday;

    if (mode === 'log' && !due) return { show: false };

    let tone: ReminderTone;
    let sub: string;
    if (mode === 'countdown' && !due) {
      const next = nextScheduled(weekdays, shiftDate(today, 1));
      tone = 'ongoing';
      sub = next ? `Next ${WEEKDAY_SHORT[next.getDay()]}` : 'Scheduled';
    } else {
      tone = overdue ? 'red' : 'orange';
      sub = overdue ? `Overdue since ${WEEKDAY_SHORT[last.getDay()]}` : dueText || 'Due today';
    }
    return { show: true, tone, sub, daysText: dText, overdue, pulse: overdue && mode === 'log' };
  }

  const everyDays = r.every_days ?? 3;
  const overdueDays = r.overdue_days ?? everyDays * 2;
  const due = days === null || days >= everyDays;
  const overdue = days === null || days >= overdueDays;
  if (mode === 'log' && !due) return { show: false };

  let tone: ReminderTone;
  let sub: string;
  if (mode === 'countdown') {
    if (overdue) {
      tone = 'red';
      sub = 'Overdue';
    } else if (due) {
      tone = 'orange';
      sub = dueText || 'Due now';
    } else {
      const left = everyDays - (days as number);
      tone = 'ongoing';
      sub = `Due in ${left} day${left !== 1 ? 's' : ''}`;
    }
  } else {
    tone = overdue ? 'red' : 'orange';
    sub = days === null ? 'Start tracking!' : overdue ? 'Overdue!' : dueText || 'Time to change';
  }
  return { show: true, tone, sub, daysText: dText, overdue, pulse: overdue && mode === 'log' };
}

export function isReminderTimeGated(r: ReminderDef, timeOfDay: TimeOfDay): boolean {
  const times = r.times || [];
  return times.length > 0 && !times.includes(timeOfDay);
}

export function isReminderSnoozed(r: ReminderDef, todayISO: string): boolean {
  return !!r.snoozed_until && r.snoozed_until > todayISO;
}

export interface VisibleReminder {
  reminder: ReminderDef;
  state: ReminderState;
}

export function visibleReminders(
  reminders: ReminderDef[],
  entries: ActivityEntry[],
  todayISO: string,
  timeOfDay: TimeOfDay,
): VisibleReminder[] {
  const out: VisibleReminder[] = [];
  for (const r of reminders) {
    if (isReminderSnoozed(r, todayISO)) continue;
    const state = computeReminderState(r, entries, todayISO);
    if (!state.show) continue;
    if (isReminderTimeGated(r, timeOfDay)) continue;
    out.push({ reminder: r, state });
  }
  return out;
}

export function companionToPrompt(
  reminders: ReminderDef[],
  entries: ActivityEntry[],
  loggedType: string,
  date: string,
): ReminderDef | null {
  const src = reminders.find((r) => r.type === loggedType);
  if (!src || !src.companion) return null;
  const comp = reminders.find((r) => r.type === src.companion);
  if (!comp) return null;
  if (entries.some((e) => e.type === comp.type && e.date === date)) return null;
  return comp;
}
