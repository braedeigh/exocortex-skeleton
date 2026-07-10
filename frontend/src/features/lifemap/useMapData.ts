import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import type { ReminderDef } from '../todos/types';
import * as apiMap from './api';
import {
  applyActivityLog,
  applyActivityRemove,
  applyContactHistoryRemove,
  applyContactLog,
  applyContactRemove,
  applyContactReorder,
  applyContactThreshold,
  applyHabitHidden,
  applyHabitRemove,
  applyHabitReorder,
  applyHabitToggle,
  applyRemindersSave,
  applyRunLog,
  applyRunRemove,
  applyTripLog,
  applyTripRemove,
} from './optimistic';
import type { MapData } from './types';

export const MAP_QUERY_KEY = ['data', 'map'] as const;

export { useToasts } from '../todos/useTodayData';

/** Primary tab data — polled every 5s like the old core.js render loop
 * (and useTodayData on /todos). */
export function useMapData() {
  return useQuery({
    queryKey: MAP_QUERY_KEY,
    queryFn: ({ signal }) => apiMap.getMapData(signal),
    refetchInterval: 5000,
  });
}

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: MapData, vars: TVars) => MapData,
  onError: (message: string) => void,
  failMessage: string,
): UseMutationResult<unknown, unknown, TVars, { previous?: MapData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: MAP_QUERY_KEY });
      const previous = queryClient.getQueryData<MapData>(MAP_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<MapData>(MAP_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(MAP_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : failMessage);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MAP_QUERY_KEY });
    },
  });
}

/** Non-optimistic helper: fire the POST, surface errors, refetch on settle.
 * Used where the old code just POSTed + loadDashboard()ed (structure edits
 * whose bookkeeping lives server-side, e.g. HABITS.md rewrites). */
function useServerMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  onError: (message: string) => void,
  failMessage: string,
): UseMutationResult<unknown, unknown, TVars, unknown> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onError: (err) => onError(err instanceof ApiError ? err.message : failMessage),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MAP_QUERY_KEY });
    },
  });
}

// --- Activity card actions ---------------------------------------------------

export function useActivityActions(onError: (message: string) => void) {
  const logAct = useOptimisticMutation(
    (v: { date: string; type: string }) => apiMap.logActivity(v.date, v.type),
    (data, v) => applyActivityLog(data, v.date, v.type),
    onError,
    "Couldn't log activity — try again",
  );
  const removeAct = useOptimisticMutation(
    (v: { date: string; type: string }) => apiMap.removeActivity(v.date, v.type),
    (data, v) => applyActivityRemove(data, v.date, v.type),
    onError,
    "Couldn't remove that activity — try again",
  );
  const logRun = useOptimisticMutation(
    (v: { date: string; minutes: number | null; notes: string }) => apiMap.logRun(v.date, v.minutes, v.notes),
    (data, v) => applyRunLog(data, v.date, v.minutes, v.notes),
    onError,
    "Couldn't log the run — try again",
  );
  const removeRun = useOptimisticMutation(
    (date: string) => apiMap.removeRun(date),
    (data, date) => applyRunRemove(data, date),
    onError,
    "Couldn't remove that run — try again",
  );
  const logTrip = useOptimisticMutation(
    (date: string) => apiMap.logKitchenTrip(date),
    (data, date) => applyTripLog(data, date),
    onError,
    "Couldn't log the kitchen trip — try again",
  );
  const removeTrip = useOptimisticMutation(
    (date: string) => apiMap.removeKitchenTrip(date),
    (data, date) => applyTripRemove(data, date),
    onError,
    "Couldn't remove that kitchen trip — try again",
  );

  return {
    logActivity: (date: string, type: string) => logAct.mutate({ date, type }),
    removeActivity: (date: string, type: string) => removeAct.mutate({ date, type }),
    logRun: (date: string, minutes: number | null, notes: string) => logRun.mutate({ date, minutes, notes }),
    removeRun: (date: string) => removeRun.mutate(date),
    logTrip: (date: string) => logTrip.mutate(date),
    removeTrip: (date: string) => removeTrip.mutate(date),
  };
}

// --- Reminder registry actions -------------------------------------------------

export function useReminderRegistryActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (reminders: unknown[]) => apiMap.saveReminders(reminders),
    onMutate: async (reminders) => {
      await queryClient.cancelQueries({ queryKey: MAP_QUERY_KEY });
      const previous = queryClient.getQueryData<MapData>(MAP_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<MapData>(
          MAP_QUERY_KEY,
          applyRemindersSave(previous, reminders as ReminderDef[]),
        );
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(MAP_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : "Couldn't save reminders — try again");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MAP_QUERY_KEY });
    },
  });

  return {
    /** Resolves so the panel can close only on success (old code alert()ed on failure). */
    save: (reminders: unknown[]) => save.mutateAsync(reminders),
  };
}

// --- Contacts actions -------------------------------------------------------------

export function useContactActions(onError: (message: string) => void) {
  const log = useOptimisticMutation(
    (v: { name: string; method: string; date: string }) => apiMap.logContact(v.name, v.method, v.date),
    (data, v) => applyContactLog(data, v.name, v.method, v.date),
    onError,
    "Couldn't log that contact — try again",
  );
  const threshold = useOptimisticMutation(
    (v: { name: string; days: number }) => apiMap.updateContactThreshold(v.name, v.days),
    (data, v) => applyContactThreshold(data, v.name, v.days),
    onError,
    "Couldn't update the contact cadence — try again",
  );
  const reorder = useOptimisticMutation(
    (order: string[]) => apiMap.reorderContacts(order),
    (data, order) => applyContactReorder(data, order),
    onError,
    "Couldn't reorder contacts — try again",
  );
  const remove = useOptimisticMutation(
    (name: string) => apiMap.removeContact(name),
    (data, name) => applyContactRemove(data, name),
    onError,
    "Couldn't remove that contact — try again",
  );
  const removeHistory = useOptimisticMutation(
    (v: { name: string; date: string; method: string }) => apiMap.removeContactHistory(v.name, v.date, v.method),
    (data, v) => applyContactHistoryRemove(data, v.name, v.date, v.method),
    onError,
    "Couldn't remove that contact log — try again",
  );
  const add = useServerMutation(
    (v: { name: string; threshold: number }) => apiMap.addContact(v.name, v.threshold),
    onError,
    "Couldn't add that contact — try again",
  );

  return {
    log: (name: string, method: string, date: string) => log.mutate({ name, method, date }),
    updateThreshold: (name: string, days: number) => threshold.mutate({ name, days }),
    reorder: (order: string[]) => reorder.mutate(order),
    remove: (name: string) => remove.mutate(name),
    removeHistory: (name: string, date: string, method: string) => removeHistory.mutate({ name, date, method }),
    add: (name: string, threshold: number) => add.mutateAsync({ name, threshold }),
  };
}

// --- Habit tracker actions ----------------------------------------------------------

export function useHabitTrackerActions(onError: (message: string) => void) {
  const toggleDate = useOptimisticMutation(
    (v: { habit: string; date: string; section: string }) => apiMap.toggleHabitDate(v.habit, v.date, v.section),
    (data, v) => applyHabitToggle(data, v.section, v.habit, v.date),
    onError,
    "Couldn't save that habit check — try again",
  );
  const reorder = useOptimisticMutation(
    (v: { section: string; items: string[] }) => apiMap.reorderHabits(v.section, v.items),
    (data, v) => applyHabitReorder(data, v.section, v.items),
    onError,
    "Couldn't reorder habits — try again",
  );
  const setHidden = useOptimisticMutation(
    (hidden: string[]) => apiMap.saveHabitSettings(hidden),
    (data, hidden) => applyHabitHidden(data, hidden),
    onError,
    "Couldn't update hidden habits — try again",
  );
  const remove = useOptimisticMutation(
    (item: string) => apiMap.removeHabit(item),
    (data, item) => applyHabitRemove(data, item),
    onError,
    "Couldn't remove that habit — try again",
  );
  const add = useServerMutation(
    (v: { item: string; section: string }) => apiMap.addHabit(v.item, v.section),
    onError,
    "Couldn't add that habit — try again",
  );
  const move = useServerMutation(
    (v: { item: string; toSection: string }) => apiMap.moveHabit(v.item, v.toSection),
    onError,
    "Couldn't move that habit — try again",
  );
  const rename = useServerMutation(
    (v: { oldName: string; newName: string; section: string }) => apiMap.renameHabit(v.oldName, v.newName, v.section),
    onError,
    "Couldn't rename that habit — try again",
  );
  const promote = useServerMutation(
    (v: { section: string; habit: string }) => apiMap.promoteHabitCadence(v.section, v.habit),
    onError,
    "Couldn't promote that habit's cadence — try again",
  );
  const restore = useServerMutation(
    (v: { section: string; habit: string }) => apiMap.restoreHabitCadence(v.section, v.habit),
    onError,
    "Couldn't restore that habit's cadence — try again",
  );
  const configure = useServerMutation(
    (payload: apiMap.HabitConfigurePayload) => apiMap.configureHabit(payload),
    onError,
    "Couldn't save that habit — try again",
  );

  return {
    toggleDate: (habit: string, date: string, section: string) => toggleDate.mutate({ habit, date, section }),
    reorder: (section: string, items: string[]) => reorder.mutate({ section, items }),
    setHidden: (hidden: string[]) => setHidden.mutate(hidden),
    remove: (item: string) => remove.mutate(item),
    add: (item: string, section: string) => add.mutateAsync({ item, section }).catch(() => undefined),
    move: (item: string, toSection: string) => move.mutate({ item, toSection }),
    rename: (oldName: string, newName: string, section: string) => rename.mutate({ oldName, newName, section }),
    promote: (section: string, habit: string) => promote.mutate({ section, habit }),
    restore: (section: string, habit: string) => restore.mutate({ section, habit }),
    configure: (payload: apiMap.HabitConfigurePayload) => configure.mutateAsync(payload),
  };
}
