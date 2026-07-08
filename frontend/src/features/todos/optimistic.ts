import { addDays } from './todoHelpers';
import { isFrosted } from './types';
import type { TodayData, TodoItem, TodoSection } from './types';

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
