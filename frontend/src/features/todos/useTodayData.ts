import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  addGrowthNote,
  addSubtask,
  addTodo,
  autosortTodos,
  bulkTodos,
  getSymptomDefinitions,
  incorporateGrowthNote,
  logActivity,
  logSymptoms,
  moveTodo,
  promoteHabitCadence,
  reactivateGrowthNote,
  removeActivity,
  removeGrowthNote,
  removeStreak,
  removeSubtask,
  removeTodo,
  renameTodo,
  reorderTodos,
  restoreHabitCadence,
  snoozeReminder,
  snoozeTodo,
  todoDetails,
  toggleHabit,
  toggleSubtask,
  toggleTodo,
  getTodayData,
  updateStreakNotes,
} from '../../api/endpoints';
import type { AddTodoPayload, BulkTodoAction, SymptomLevels, TodoDetailsPatch } from '../../api/endpoints';
import {
  applyActivityLog,
  applyActivityRemove,
  applyAdd,
  applyAutosort,
  applyBulk,
  applyDetails,
  applyHabitToggle,
  applyMove,
  applyRemove,
  applyRename,
  applyReminderSnooze,
  applyReorder,
  applySnooze,
  applyStreakNotes,
  applyStreakRemove,
  applySubtaskAdd,
  applySubtaskRemove,
  applySubtaskToggle,
  applySymptomLog,
  applyToggle,
} from './optimistic';
import type { SubTask, TodayData, TodoItem } from './types';

export const TODAY_QUERY_KEY = ['data', 'today'] as const;

export function useTodayData() {
  return useQuery({
    queryKey: TODAY_QUERY_KEY,
    queryFn: ({ signal }) => getTodayData(signal),
    refetchInterval: 5000,
  });
}

export interface Toast {
  id: number;
  message: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string) => {
    const id = nextId.current++;
    setToasts((cur) => [...cur, { id, message }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: TodayData, vars: TVars) => TodayData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: TodayData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: TODAY_QUERY_KEY });
      const previous = queryClient.getQueryData<TodayData>(TODAY_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<TodayData>(TODAY_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(TODAY_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TODAY_QUERY_KEY });
    },
  });
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

export function useTodoActions(onError: (message: string) => void) {
  const toggle = useOptimisticMutation((id: string) => toggleTodo(id), applyToggle, onError);
  const remove = useOptimisticMutation((id: string) => removeTodo(id), applyRemove, onError);
  const rename = useOptimisticMutation(
    (vars: { id: string; text: string }) => renameTodo(vars.id, vars.text),
    (data, vars) => applyRename(data, vars.id, vars.text),
    onError,
  );
  const snooze = useOptimisticMutation(
    (vars: { id: string; days: number }) => snoozeTodo(vars.id, vars.days),
    (data, vars) => applySnooze(data, vars.id, vars.days),
    onError,
  );
  const details = useOptimisticMutation(
    (vars: { id: string; patch: TodoDetailsPatch }) => todoDetails(vars.id, vars.patch),
    (data, vars) => applyDetails(data, vars.id, vars.patch),
    onError,
  );
  const move = useOptimisticMutation(
    (vars: { id: string; toLabel: string }) => moveTodo(vars.id, vars.toLabel),
    (data, vars) => applyMove(data, vars.id, vars.toLabel),
    onError,
  );
  const reorder = useOptimisticMutation(
    (vars: { section: string; ids: string[] }) => reorderTodos(vars.section, vars.ids),
    (data, vars) => applyReorder(data, vars.section, vars.ids),
    onError,
  );
  const autosort = useOptimisticMutation(
    (section: string) => autosortTodos(section),
    (data, section) => applyAutosort(data, section),
    onError,
  );
  const add = useOptimisticMutation(
    (vars: AddTodoPayload & { tempItem: TodoItem }) => addTodo(vars),
    (data, vars) => applyAdd(data, vars.tempItem, vars.section),
    onError,
  );
  const bulk = useOptimisticMutation(
    (vars: { ids: string[]; action: BulkTodoAction }) => bulkTodos(vars.ids, vars.action),
    (data, vars) => applyBulk(data, vars.ids, vars.action),
    onError,
  );
  const subtaskAdd = useOptimisticMutation(
    (vars: { id: string; text: string; tempSub: SubTask }) => addSubtask(vars.id, vars.text),
    (data, vars) => applySubtaskAdd(data, vars.id, vars.tempSub),
    onError,
  );
  const subtaskToggle = useOptimisticMutation(
    (vars: { id: string; subId: string }) => toggleSubtask(vars.id, vars.subId),
    (data, vars) => applySubtaskToggle(data, vars.id, vars.subId),
    onError,
  );
  const subtaskRemove = useOptimisticMutation(
    (vars: { id: string; subId: string }) => removeSubtask(vars.id, vars.subId),
    (data, vars) => applySubtaskRemove(data, vars.id, vars.subId),
    onError,
  );

  return {
    toggle: (id: string) => toggle.mutate(id),
    remove: (id: string) => remove.mutate(id),
    rename: (id: string, text: string) => rename.mutate({ id, text }),
    snooze: (id: string, days: number) => snooze.mutate({ id, days }),
    details: (id: string, patch: TodoDetailsPatch) => details.mutate({ id, patch }),
    move: (id: string, toLabel: string) => move.mutate({ id, toLabel }),
    reorder: (section: string, ids: string[]) => reorder.mutate({ section, ids }),
    autosort: (section: string) => autosort.mutate(section),
    bulk: (ids: string[], action: BulkTodoAction) => bulk.mutate({ ids, action }),
    subtaskAdd: (id: string, text: string) => {
      const tempSub: SubTask = { id: tempId(), text, done: false };
      subtaskAdd.mutate({ id, text, tempSub });
    },
    subtaskToggle: (id: string, subId: string) => subtaskToggle.mutate({ id, subId }),
    subtaskRemove: (id: string, subId: string) => subtaskRemove.mutate({ id, subId }),
    add: (payload: AddTodoPayload) => {
      const item: TodoItem = {
        id: tempId(),
        text: payload.item,
        done: false,
        due_by: payload.due_by || null,
        due_time: payload.due_time || null,
        notes: payload.notes || null,
        place_id: payload.place_id || null,
        status: payload.status || null,
        theme: payload.theme || null,
        duration_min: payload.duration_min || null,
        after_date: payload.after_date || null,
        after_id: payload.after_id || null,
      };
      add.mutate({ ...payload, tempItem: item });
    },
  };
}

export function useReminderActions(onError: (message: string) => void) {
  const log = useOptimisticMutation(
    (vars: { date: string; type: string }) => logActivity(vars.date, vars.type),
    (data, vars) => applyActivityLog(data, vars.date, vars.type),
    onError,
  );
  const undo = useOptimisticMutation(
    (vars: { date: string; type: string }) => removeActivity(vars.date, vars.type),
    (data, vars) => applyActivityRemove(data, vars.date, vars.type),
    onError,
  );
  const snooze = useOptimisticMutation(
    (vars: { id: string; days: number }) => snoozeReminder(vars.id, vars.days),
    (data, vars) => applyReminderSnooze(data, vars.id, vars.days),
    onError,
  );

  return {
    log: (date: string, type: string) => log.mutate({ date, type }),
    undo: (date: string, type: string) => undo.mutate({ date, type }),
    snooze: (id: string, days: number) => snooze.mutate({ id, days }),
  };
}

/** Custom "what 0–3 means" tooltips for the symptom buttons. Definitions only
 * change from the Body tab's editor, so a long staleTime keeps this off the
 * 5s poll cadence. */
export function useSymptomDefinitions() {
  return useQuery({
    queryKey: ['data', 'symptom-definitions'] as const,
    queryFn: ({ signal }) => getSymptomDefinitions(signal),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSymptomActions(onError: (message: string) => void) {
  const log = useOptimisticMutation(
    (vars: { date: string; symptoms: SymptomLevels }) => logSymptoms(vars.date, vars.symptoms),
    (data, vars) => applySymptomLog(data, vars.date, vars.symptoms),
    onError,
  );

  return {
    log: (date: string, symptoms: SymptomLevels) => log.mutate({ date, symptoms }),
  };
}

/** Streak (day-counter) mutations — label+since is the identity key. */
export function useStreakActions(onError: (message: string) => void) {
  const saveNotes = useOptimisticMutation(
    (vars: { label: string; since: string; notes: string }) =>
      updateStreakNotes(vars.label, vars.since, vars.notes),
    (data, vars) => applyStreakNotes(data, vars.label, vars.since, vars.notes),
    onError,
  );
  const remove = useOptimisticMutation(
    (vars: { label: string; since: string }) => removeStreak(vars.label, vars.since),
    (data, vars) => applyStreakRemove(data, vars.label, vars.since),
    onError,
  );

  return {
    saveNotes: (label: string, since: string, notes: string) => saveNotes.mutate({ label, since, notes }),
    remove: (label: string, since: string) => remove.mutate({ label, since }),
  };
}

/**
 * Habit mutations, sharing the same TODAY_QUERY_KEY cache as todos/reminders.
 * `toggle` is optimistic (instant checkbox flip via applyHabitToggle).
 * `promote`/`restore` intentionally do NOT touch the cache optimistically —
 * the cadence-ladder math (next_check scheduling, pass counts) lives
 * server-side in habit_cadence.py and isn't ported here, so we let the 5s
 * poll / onSettled invalidate pick up the real result. The "graduated!"
 * confirmation is transient local component state instead (mirrors the old
 * window._gradRecent pattern) — see GraduationPrompts.tsx.
 */
export function useHabitActions(onError: (message: string) => void) {
  const toggle = useOptimisticMutation(
    (vars: { habit: string; section: string; date: string }) => toggleHabit(vars.habit, vars.section, vars.date),
    (data, vars) => applyHabitToggle(data, vars.section, vars.habit, vars.date),
    onError,
  );
  const promote = useOptimisticMutation(
    (vars: { section: string; habit: string }) => promoteHabitCadence(vars.section, vars.habit),
    (data) => data,
    onError,
  );
  const restore = useOptimisticMutation(
    (vars: { section: string; habit: string }) => restoreHabitCadence(vars.section, vars.habit),
    (data) => data,
    onError,
  );

  return {
    toggle: (habit: string, section: string, date: string) => toggle.mutate({ habit, section, date }),
    promote: (section: string, habit: string) => promote.mutate({ section, habit }),
    restore: (section: string, habit: string) => restore.mutate({ section, habit }),
  };
}

/**
 * Growth Notes ("Working On" aspirations) mutations. Like promote/restore
 * above, these skip the optimistic cache write — the list is short and
 * low-frequency enough that the 5s poll / onSettled invalidate picking up
 * the real result isn't perceptibly slower, and it avoids duplicating the
 * add/remove/incorporate bookkeeping client-side.
 */
export function useGrowthActions(onError: (message: string) => void) {
  const add = useOptimisticMutation((text: string) => addGrowthNote(text), (data) => data, onError);
  const remove = useOptimisticMutation((text: string) => removeGrowthNote(text), (data) => data, onError);
  const incorporate = useOptimisticMutation(
    (text: string) => incorporateGrowthNote(text),
    (data) => data,
    onError,
  );
  const reactivate = useOptimisticMutation(
    (text: string) => reactivateGrowthNote(text),
    (data) => data,
    onError,
  );

  return {
    add: (text: string) => add.mutate(text),
    remove: (text: string) => remove.mutate(text),
    incorporate: (text: string) => incorporate.mutate(text),
    reactivate: (text: string) => reactivate.mutate(text),
  };
}
