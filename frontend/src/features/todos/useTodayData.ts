import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  addCard,
  addGrowthNote,
  addStreak,
  addSubtask,
  addTodo,
  deleteCard,
  getStreakNotes,
  retireStreak,
  updateCard,
  updateStreak,
  autosortTodos,
  bulkTodos,
  incorporateGrowthNote,
  logActivity,
  moveTodo,
  promoteHabitCadence,
  reactivateGrowthNote,
  removeActivity,
  removeGrowthNote,
  removeStreak,
  removeSubtask,
  removeAgentNote,
  removeTodo,
  renameTodo,
  reorderTodos,
  restoreHabitCadence,
  saveReminders,
  snoozeReminder,
  snoozeTodo,
  todoDetails,
  toggleHabit,
  toggleSubtask,
  toggleTodo,
  getTodayData,
} from '../../api/endpoints';
import type { AddTodoPayload, AddTodoResponse, BulkTodoAction, TodoDetailsPatch } from '../../api/endpoints';
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
  applyReminderPatch,
  applyReminderSnooze,
  applyReorder,
  applySnooze,
  applyStreakHabitLink,
  applyStreakNotes,
  applyStreakRemove,
  applyStreakRetire,
  applySubtaskAdd,
  applySubtaskRemove,
  applyAgentNoteRemove,
  applySubtaskToggle,
  applyToggle,
} from './optimistic';
import type { ReminderDef, SubTask, TodayData, TodoItem } from './types';

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

function useOptimisticMutation<TVars, TData = unknown>(
  mutationFn: (vars: TVars) => Promise<TData>,
  updater: (data: TodayData, vars: TVars) => TodayData,
  onError: (message: string) => void,
): UseMutationResult<TData, unknown, TVars, { previous?: TodayData }> {
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

/** The optimistic stand-in for a freshly-added to-do, shown in place until
 * the server's response (and the next poll) replace it with the real item. */
function buildTempAddItem(payload: AddTodoPayload): TodoItem {
  return {
    id: tempId(),
    text: payload.item,
    done: false,
    due_by: payload.due_by || null,
    due_time: payload.due_time || null,
    notes: payload.notes || null,
    place_id: payload.place_id || null,
    fronts: payload.fronts || [],
    duration_min: payload.duration_min || null,
    after_date: payload.after_date || null,
    after_id: payload.after_id || null,
  };
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
  const add = useOptimisticMutation<AddTodoPayload & { tempItem: TodoItem }, AddTodoResponse>(
    (vars) => addTodo(vars),
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
  const agentNoteRemove = useOptimisticMutation(
    (vars: { id: string; by: string; at: string }) => removeAgentNote(vars.id, vars.by, vars.at),
    (data, vars) => applyAgentNoteRemove(data, vars.id, vars.by, vars.at),
    onError,
  );

  return {
    agentNoteRemove: (id: string, by: string, at: string) => agentNoteRemove.mutate({ id, by, at }),
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
      add.mutate({ ...payload, tempItem: buildTempAddItem(payload) });
    },
    /** Same mutation as `add`, but awaitable and resolving to the server's
     * {ok, id} — for flows (the upcoming unified add/edit modal) that need
     * to chain a follow-up call (e.g. a snooze) onto the freshly-created id. */
    addAsync: (payload: AddTodoPayload): Promise<AddTodoResponse> =>
      add.mutateAsync({ ...payload, tempItem: buildTempAddItem(payload) }),
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
  // Edits one reminder's definition (e.g. every_days) in place: POSTs the
  // full list (the save endpoint replaces wholesale) with the patch applied.
  const update = useOptimisticMutation(
    (vars: { id: string; patch: Partial<ReminderDef>; all: ReminderDef[] }) =>
      saveReminders(vars.all.map((r) => (r.id === vars.id ? { ...r, ...vars.patch } : r))),
    (data, vars) => applyReminderPatch(data, vars.id, vars.patch),
    onError,
  );

  return {
    log: (date: string, type: string) => log.mutate({ date, type }),
    undo: (date: string, type: string) => undo.mutate({ date, type }),
    snooze: (id: string, days: number) => snooze.mutate({ id, days }),
    update: (id: string, patch: Partial<ReminderDef>, all: ReminderDef[]) =>
      update.mutate({ id, patch, all }),
  };
}

/** Streak (day-counter) mutations — id is the identity key. */
export function useStreakActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const saveNotes = useOptimisticMutation(
    (vars: { id: string; notes: string }) => updateStreak(vars.id, { notes: vars.notes }),
    (data, vars) => applyStreakNotes(data, vars.id, vars.notes),
    onError,
  );
  const setHabit = useOptimisticMutation(
    (vars: { id: string; habitKey: string }) => updateStreak(vars.id, { habit_key: vars.habitKey }),
    (data, vars) => applyStreakHabitLink(data, vars.id, vars.habitKey),
    onError,
  );
  const remove = useOptimisticMutation(
    (vars: { id: string }) => removeStreak(vars.id),
    (data, vars) => applyStreakRemove(data, vars.id),
    onError,
  );
  const retire = useOptimisticMutation(
    (vars: { id: string; note: string }) => retireStreak(vars.id, vars.note),
    (data, vars) => applyStreakRetire(data, vars.id),
    onError,
  );
  // Add is not optimistic — the server mints id/slug, so we just refetch.
  const add = useMutation({
    mutationFn: (vars: { label: string; since: string }) => addStreak(vars.label, vars.since),
    onSettled: () => queryClient.invalidateQueries({ queryKey: TODAY_QUERY_KEY }),
    onError: (e) => onError(e instanceof ApiError ? e.message : 'Could not add day count'),
  });

  return {
    saveNotes: (id: string, notes: string) => saveNotes.mutate({ id, notes }),
    setHabit: (id: string, habitKey: string) => setHabit.mutate({ id, habitKey }),
    remove: (id: string) => remove.mutate({ id }),
    retire: (id: string, note: string) => retire.mutate({ id, note }),
    add: (label: string, since: string) => add.mutate({ label, since }),
  };
}

/** A counter's note cells (pool cards tagged counter-<slug>) + append/edit.
 * Shared by the Today streak sheet and the Life Map retired card. */
export function useStreakNotes(slug: string | null, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const queryKey = ['streak-notes', slug ?? ''];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getStreakNotes(slug as string, signal),
    enabled: !!slug,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey });
  const fail = (e: unknown, fallback: string) =>
    onError(e instanceof ApiError ? e.message : fallback);

  const append = useMutation({
    // Note cells are REAL journal cards — they land at the bottom of today's
    // timeline and carry the counter's tag, which is what the counter's own
    // stream (and the journal's counter chip) key off.
    mutationFn: (vars: { tag: string; body: string }) =>
      addCard(localToday(), 'bottom', vars.body, [vars.tag]),
    onSettled: invalidate,
    onError: (e) => fail(e, 'Could not add note'),
  });
  const edit = useMutation({
    mutationFn: (vars: { id: string; body: string }) => updateCard(vars.id, vars.body),
    onSettled: invalidate,
    onError: (e) => fail(e, 'Could not save note'),
  });
  const removeNote = useMutation({
    mutationFn: (vars: { id: string }) => deleteCard(vars.id),
    onSettled: invalidate,
    onError: (e) => fail(e, 'Could not remove note'),
  });

  return {
    notes: query.data?.notes ?? [],
    loading: query.isLoading,
    append: (tag: string, body: string) => append.mutate({ tag, body }),
    appending: append.isPending,
    edit: (id: string, body: string) => edit.mutate({ id, body }),
    remove: (id: string) => removeNote.mutate({ id }),
  };
}

/** Local YYYY-MM-DD — where a freshly appended note cell lands. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
