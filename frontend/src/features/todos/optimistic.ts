import { habitKey } from '../habits/habitMath';
import { addDays } from './todoHelpers';
import { isFrosted } from './types';
import type { TodayData, TodoItem, TodoSection } from './types';
import type { SymptomLevels } from '../../api/endpoints';

function withSections(data: TodayData, fn: (sections: TodoSection[]) => TodoSection[]): TodayData {
  if (isFrosted(data.todos)) return data;
  return { ...data, todos: fn(data.todos) };
}

export function applyToggle(data: TodayData, id: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) =>
        it.id === id
          ? { ...it, done: !it.done, done_at: !it.done ? data.server_date : null }
          : it,
      ),
    })),
  );
}

export function applyRemove(data: TodayData, id: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({ ...sec, items: sec.items.filter((it) => it.id !== id) })),
  );
}

export function applyRename(data: TodayData, id: string, text: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (it.id === id ? { ...it, text } : it)),
    })),
  );
}

export function applySnooze(data: TodayData, id: string, days: number): TodayData {
  const until = days > 0 ? addDays(data.server_date, days) : null;
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (it.id === id ? { ...it, snoozed_until: until } : it)),
    })),
  );
}

export function applyDetails(data: TodayData, id: string, patch: Partial<TodoItem>): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    })),
  );
}

export function applyMove(data: TodayData, id: string, toLabel: string): TodayData {
  return withSections(data, (sections) => {
    let moved: TodoItem | undefined;
    const stripped = sections.map((sec) => {
      const idx = sec.items.findIndex((it) => it.id === id);
      if (idx === -1) return sec;
      moved = sec.items[idx];
      return { ...sec, items: sec.items.filter((it) => it.id !== id) };
    });
    if (!moved) return stripped;
    const item = moved;
    return stripped.map((sec) => (sec.name === toLabel ? { ...sec, items: [item, ...sec.items] } : sec));
  });
}

export function applyReorder(data: TodayData, sectionLabel: string, ids: string[]): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => {
      if (sec.name !== sectionLabel) return sec;
      const byId = new Map(sec.items.map((it) => [it.id, it]));
      const ordered = ids.map((id) => byId.get(id)).filter((it): it is TodoItem => !!it);
      return { ...sec, manual_order: true, items: ordered };
    }),
  );
}

export function applyAutosort(data: TodayData, sectionLabel: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => (sec.name === sectionLabel ? { ...sec, manual_order: false } : sec)),
  );
}

export function applyAdd(data: TodayData, tempItem: TodoItem, sectionLabel: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => (sec.name === sectionLabel ? { ...sec, items: [tempItem, ...sec.items] } : sec)),
  );
}

export function applyReminderSnooze(data: TodayData, id: string, days: number): TodayData {
  if (!data.reminders) return data;
  const until = days > 0 ? addDays(data.server_date, days) : null;
  return {
    ...data,
    reminders: data.reminders.map((r) => (r.id === id ? { ...r, snoozed_until: until } : r)),
  };
}

export function applyActivityLog(data: TodayData, date: string, type: string): TodayData {
  const entries = data.activity_log.filter((e) => !(e.date === date && e.type === type));
  entries.push({ date, type });
  return { ...data, activity_log: entries };
}

export function applyActivityRemove(data: TodayData, date: string, type: string): TodayData {
  return { ...data, activity_log: data.activity_log.filter((e) => !(e.date === date && e.type === type)) };
}

/** Merge a symptom log into the health_data row for `date` (inserting the row
 * if it's missing) — mirrors /api/symptoms' upsert, so the symptom card flips
 * to its logged state without waiting for the poll. */
export function applySymptomLog(data: TodayData, date: string, symptoms: SymptomLevels): TodayData {
  const rows = data.health_data;
  if (!Array.isArray(rows)) return data;
  const exists = rows.some((r) => r.date === date);
  const next = exists
    ? rows.map((r) => (r.date === date ? { ...r, ...symptoms } : r))
    : [...rows, { date, ...symptoms }];
  return { ...data, health_data: next };
}

/** Streaks are keyed by label+since (same composite key the server uses). */
export function applyStreakNotes(data: TodayData, label: string, since: string, notes: string): TodayData {
  if (!Array.isArray(data.streaks)) return data;
  return {
    ...data,
    streaks: data.streaks.map((s) => (s.label === label && s.since === since ? { ...s, notes } : s)),
  };
}

export function applyStreakRemove(data: TodayData, label: string, since: string): TodayData {
  if (!Array.isArray(data.streaks)) return data;
  return {
    ...data,
    streaks: data.streaks.filter((s) => !(s.label === label && s.since === since)),
  };
}

/** Flip a single habit's completion for `date` — mirrors the server's toggle
 * semantics (present -> removed, absent -> set true) so the optimistic
 * update matches what /api/habits/toggle will actually do. */
export function applyHabitToggle(data: TodayData, section: string, habit: string, date: string): TodayData {
  const key = habitKey(section, habit);
  const log = data.habits_log || {};
  const day = { ...(log[date] || {}) };
  if (day[key]) delete day[key];
  else day[key] = true;
  return { ...data, habits_log: { ...log, [date]: day } };
}
