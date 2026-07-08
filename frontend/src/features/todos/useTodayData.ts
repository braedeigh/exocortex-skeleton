import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  addTodo,
  autosortTodos,
  logActivity,
  moveTodo,
  removeActivity,
  removeTodo,
  renameTodo,
  reorderTodos,
  snoozeReminder,
  snoozeTodo,
  todoDetails,
  toggleTodo,
  getTodayData,
} from '../../api/endpoints';
import type { AddTodoPayload, TodoDetailsPatch } from '../../api/endpoints';
import {
  applyActivityLog,
  applyActivityRemove,
  applyAdd,
  applyAutosort,
  applyDetails,
  applyMove,
  applyRemove,
  applyRename,
  applyReminderSnooze,
  applyReorder,
  applySnooze,
  applyToggle,
} from './optimistic';
import type { TodayData, TodoItem } from './types';

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

  return {
    toggle: (id: string) => toggle.mutate(id),
    remove: (id: string) => remove.mutate(id),
    rename: (id: string, text: string) => rename.mutate({ id, text }),
    snooze: (id: string, days: number) => snooze.mutate({ id, days }),
    details: (id: string, patch: TodoDetailsPatch) => details.mutate({ id, patch }),
    move: (id: string, toLabel: string) => move.mutate({ id, toLabel }),
    reorder: (section: string, ids: string[]) => reorder.mutate({ section, ids }),
    autosort: (section: string) => autosort.mutate(section),
    add: (payload: AddTodoPayload) => {
      const item: TodoItem = {
        id: tempId(),
        text: payload.item,
        done: false,
        due_by: payload.due_by || null,
        due_time: payload.due_time || null,
        notes: payload.notes || null,
        place_id: payload.place_id || null,
        category: payload.category || null,
        status: payload.status || null,
        theme: payload.theme || null,
        duration_min: payload.duration_min || null,
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
