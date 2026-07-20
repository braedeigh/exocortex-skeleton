import { habitKey } from '../habits/habitMath';
import { addDays } from './todoHelpers';
import { isFrosted } from './types';
import type { SubTask, TodayData, TodoItem, TodoSection } from './types';
import type { BulkTodoAction, SymptomLevels } from '../../api/endpoints';

function withSections(data: TodayData, fn: (sections: TodoSection[]) => TodoSection[]): TodayData {
  if (isFrosted(data.todos)) return data;
  return { ...data, todos: fn(data.todos) };
}

export function applyToggle(data: TodayData, id: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => {
        if (it.id !== id) return it;
        const done = !it.done;
        return {
          ...it,
          done,
          // Date-only optimistic stamp — the real server-side done_at is
          // minute-precision ('YYYY-MM-DDTHH:MM'); the 5s poll corrects it.
          // Cache readers only ever need the day part (slice(0, 10)), which
          // this already matches, so the optimistic value never misleads.
          done_at: done ? data.server_date : null,
          // Checking the main task marks every sub-task done too (mirrors
          // /api/todos/toggle); un-checking leaves them as they are.
          subtasks: done && it.subtasks ? it.subtasks.map((s) => ({ ...s, done: true })) : it.subtasks,
        };
      }),
    })),
  );
}

export function applySubtaskAdd(data: TodayData, id: string, subtask: SubTask): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (it.id === id ? { ...it, subtasks: [...(it.subtasks || []), subtask] } : it)),
    })),
  );
}

export function applySubtaskToggle(data: TodayData, id: string, subId: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) =>
        it.id === id
          ? { ...it, subtasks: (it.subtasks || []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s)) }
          : it,
      ),
    })),
  );
}

export function applySubtaskRemove(data: TodayData, id: string, subId: string): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => {
        if (it.id !== id) return it;
        const remaining = (it.subtasks || []).filter((s) => s.id !== subId);
        if (remaining.length) return { ...it, subtasks: remaining };
        const { subtasks: _drop, ...rest } = it;
        return rest as TodoItem;
      }),
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

/** Merge a details patch onto an item, mirroring /api/todos/details' own
 * contract: an empty-string value pops the key rather than storing "" — so
 * the truncated-text/blocker lookups (waitingReason etc.) that key off
 * "key present" don't flicker between the optimistic state and the refetch.
 * An empty `fronts` list ("clear all fronts") pops the key the same way. */
function mergeDetailsPatch(item: TodoItem, patch: Partial<TodoItem>): TodoItem {
  const next = { ...item } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === '' || (Array.isArray(value) && value.length === 0)) delete next[key];
    else next[key] = value;
  }
  return next as unknown as TodoItem;
}

export function applyDetails(data: TodayData, id: string, patch: Partial<TodoItem>): TodayData {
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (it.id === id ? mergeDetailsPatch(it, patch) : it)),
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

// --- Bulk appliers (POST /api/todos/bulk) — same per-item semantics as the
// single-item appliers above, applied to every matched id. ---

export function applyBulkDetails(data: TodayData, ids: string[], patch: Partial<TodoItem>): TodayData {
  const idSet = new Set(ids);
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (idSet.has(it.id) ? mergeDetailsPatch(it, patch) : it)),
    })),
  );
}

export function applyBulkSnooze(data: TodayData, ids: string[], days: number): TodayData {
  const idSet = new Set(ids);
  const until = days > 0 ? addDays(data.server_date, days) : null;
  return withSections(data, (sections) =>
    sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) => (idSet.has(it.id) ? { ...it, snoozed_until: until } : it)),
    })),
  );
}

/** Unlike single applyMove (which prepends), bulk APPENDS to the target in
 * encounter order and leaves items already in the target where they are —
 * mirroring the server's bulk move so the optimistic state doesn't jump
 * around when the refetch lands. */
export function applyBulkMove(data: TodayData, ids: string[], toLabel: string): TodayData {
  return withSections(data, (sections) => {
    const idSet = new Set(ids);
    const moved: TodoItem[] = [];
    const stripped = sections.map((sec) => {
      if (sec.name === toLabel) return sec;
      if (!sec.items.some((it) => idSet.has(it.id))) return sec;
      const kept: TodoItem[] = [];
      for (const it of sec.items) {
        if (idSet.has(it.id)) moved.push(it);
        else kept.push(it);
      }
      return { ...sec, items: kept };
    });
    if (!moved.length) return stripped;
    return stripped.map((sec) =>
      sec.name === toLabel ? { ...sec, items: [...sec.items, ...moved] } : sec,
    );
  });
}

export function applyBulkRemove(data: TodayData, ids: string[]): TodayData {
  const idSet = new Set(ids);
  return withSections(data, (sections) =>
    sections.map((sec) => ({ ...sec, items: sec.items.filter((it) => !idSet.has(it.id)) })),
  );
}

export function applyBulk(data: TodayData, ids: string[], action: BulkTodoAction): TodayData {
  switch (action.action) {
    case 'details':
      return applyBulkDetails(data, ids, action.patch);
    case 'snooze':
      return applyBulkSnooze(data, ids, action.days);
    case 'move':
      return applyBulkMove(data, ids, action.to_section);
    case 'remove':
      return applyBulkRemove(data, ids);
  }
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
