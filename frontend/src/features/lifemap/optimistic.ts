/**
 * optimistic.ts — cache appliers for the ['data','map'] query, mirroring what
 * each server mutation will do so the UI updates instantly (the old code
 * mutated D in place + re-rendered before awaiting the POST for the same
 * effect).
 */
import { habitKey } from '../habits/habitMath';
import type { HabitSection } from '../habits/types';
import type { ReminderDef } from '../todos/types';
import type { Contact, MapData } from './types';

// --- Activity / runs / kitchen trips -----------------------------------------

export function applyActivityLog(data: MapData, date: string, type: string): MapData {
  const entries = (data.activity_log || []).filter((e) => !(e.date === date && e.type === type));
  entries.push({ date, type });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return { ...data, activity_log: entries };
}

export function applyActivityRemove(data: MapData, date: string, type: string): MapData {
  return {
    ...data,
    activity_log: (data.activity_log || []).filter((e) => !(e.date === date && e.type === type)),
  };
}

export function applyRunLog(data: MapData, date: string, minutes: number | null, notes: string): MapData {
  const rdata = data.runs || { target_per_week: 3, runs: [] };
  const runs = (rdata.runs || []).filter((r) => r.date !== date);
  runs.push({ date, minutes, notes });
  runs.sort((a, b) => a.date.localeCompare(b.date));
  return { ...data, runs: { ...rdata, runs } };
}

export function applyRunRemove(data: MapData, date: string): MapData {
  if (!data.runs) return data;
  return { ...data, runs: { ...data.runs, runs: (data.runs.runs || []).filter((r) => r.date !== date) } };
}

export function applyTripLog(data: MapData, date: string): MapData {
  const trips = data.kitchen_trips || [];
  if (trips.some((t) => t.date === date)) return data;
  const next = [...trips, { date }];
  next.sort((a, b) => a.date.localeCompare(b.date));
  return { ...data, kitchen_trips: next };
}

export function applyTripRemove(data: MapData, date: string): MapData {
  return { ...data, kitchen_trips: (data.kitchen_trips || []).filter((t) => t.date !== date) };
}

// --- Habits -------------------------------------------------------------------

/** Flip a habit's completion for `date` (server toggle semantics). */
export function applyHabitToggle(data: MapData, section: string, habit: string, date: string): MapData {
  const key = habitKey(section, habit);
  const log = data.habits_log || {};
  const day = { ...(log[date] || {}) };
  if (day[key]) delete day[key];
  else day[key] = true;
  return { ...data, habits_log: { ...log, [date]: day } };
}

export function applyHabitHidden(data: MapData, hidden: string[]): MapData {
  return { ...data, habit_settings: { ...(data.habit_settings || {}), hidden } };
}

export function applyHabitReorder(data: MapData, section: string, items: string[]): MapData {
  const habits = (data.habits || []).map((s): HabitSection => {
    if (s.name !== section) return s;
    const byText = new Map(s.items.map((i) => [i.text, i]));
    const ordered = items.map((t) => byText.get(t)).filter((i): i is HabitSection['items'][number] => !!i);
    // Keep anything not mentioned (defensive; shouldn't happen).
    for (const i of s.items) if (!items.includes(i.text)) ordered.push(i);
    return { ...s, items: ordered };
  });
  return { ...data, habits };
}

export function applyHabitRemove(data: MapData, item: string): MapData {
  const habits = (data.habits || []).map((s) => ({ ...s, items: s.items.filter((i) => i.text !== item) }));
  return { ...data, habits };
}

// --- Contacts -------------------------------------------------------------------

function mapContacts(data: MapData, fn: (contacts: Contact[]) => Contact[]): MapData {
  if (!data.contacts) return data;
  return { ...data, contacts: fn(data.contacts) };
}

/** Mirror /api/contacts/log: bump last_contact/method when date >= current,
 * replace any same-date history entry, append the new one. days_since is
 * recomputed locally so status colors update instantly. */
export function applyContactLog(data: MapData, name: string, method: string, date: string): MapData {
  return mapContacts(data, (contacts) =>
    contacts.map((c) => {
      if (c.name !== name) return c;
      const next: Contact = { ...c };
      if (!next.last_contact || date >= next.last_contact) {
        next.last_contact = date;
        next.method = method;
        const today = data.server_date;
        next.days_since = Math.max(
          0,
          Math.round(
            (new Date(`${today}T12:00:00`).getTime() - new Date(`${date}T12:00:00`).getTime()) / 86400000,
          ),
        );
      }
      const history = (next.history || []).filter((h) => h.date !== date);
      history.push({ date, method });
      next.history = history;
      return next;
    }),
  );
}

export function applyContactThreshold(data: MapData, name: string, threshold_days: number): MapData {
  return mapContacts(data, (contacts) => contacts.map((c) => (c.name === name ? { ...c, threshold_days } : c)));
}

export function applyContactReorder(data: MapData, order: string[]): MapData {
  return mapContacts(data, (contacts) => {
    const byName = new Map(contacts.map((c) => [c.name, c]));
    const reordered = order.map((n) => byName.get(n)).filter((c): c is Contact => !!c);
    for (const c of contacts) if (!order.includes(c.name)) reordered.push(c);
    return reordered;
  });
}

export function applyContactRemove(data: MapData, name: string): MapData {
  return mapContacts(data, (contacts) => contacts.filter((c) => c.name !== name));
}

/** Mirror /api/contacts/history/remove: drop the newest matching entry, then
 * re-derive last_contact/method (and days_since) from what's left. */
export function applyContactHistoryRemove(data: MapData, name: string, date: string, method: string): MapData {
  return mapContacts(data, (contacts) =>
    contacts.map((c) => {
      if (c.name !== name) return c;
      const history = [...(c.history || [])];
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].date === date && history[i].method === method) {
          history.splice(i, 1);
          break;
        }
      }
      const next: Contact = { ...c, history };
      if (history.length) {
        const latest = history.reduce((max, h) => (h.date > max.date ? h : max), history[0]);
        next.last_contact = latest.date;
        next.method = latest.method;
        next.days_since = Math.max(
          0,
          Math.round(
            (new Date(`${data.server_date}T12:00:00`).getTime() -
              new Date(`${latest.date}T12:00:00`).getTime()) /
              86400000,
          ),
        );
      } else {
        next.last_contact = null;
        next.method = null;
        next.days_since = null;
      }
      return next;
    }),
  );
}

// --- Reminders --------------------------------------------------------------------

/** Whole-registry save — replace the list (server echoes the cleaned rows back;
 * this optimistic version just trusts the draft until the refetch). */
export function applyRemindersSave(data: MapData, reminders: ReminderDef[]): MapData {
  return { ...data, reminders };
}
