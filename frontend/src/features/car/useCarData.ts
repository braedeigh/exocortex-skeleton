/**
 * useCarData.ts — TanStack Query wiring for the Car page. Same shape as
 * features/todos/useTodayData.ts: one polled query (5s, matching the old
 * dashboard loop) + optimistic mutations that patch the cache instantly and
 * reconcile via invalidate/poll.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { addCarEntry, getCarData, removeCarEntry, saveCarNotes } from './api';
import type { AddCarEntryPayload } from './api';
import { applyEntryAdd, applyEntryRemove, applyNotesText, normalizeNewEntry } from './carMath';
import type { CarData } from './types';

export const CAR_QUERY_KEY = ['data', 'car'] as const;

export function useCarData() {
  return useQuery({
    queryKey: CAR_QUERY_KEY,
    queryFn: ({ signal }) => getCarData(signal),
    refetchInterval: 5000,
  });
}

function useOptimisticCarMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: CarData, vars: TVars) => CarData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: CarData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: CAR_QUERY_KEY });
      const previous = queryClient.getQueryData<CarData>(CAR_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<CarData>(CAR_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(CAR_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CAR_QUERY_KEY });
    },
  });
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

export function useCarActions(onError: (message: string) => void) {
  const add = useOptimisticCarMutation(
    (vars: AddCarEntryPayload & { tempId: string }) => addCarEntry(vars),
    (data, vars) => applyEntryAdd(data, normalizeNewEntry(vars, vars.tempId)),
    onError,
  );
  const remove = useOptimisticCarMutation(
    (id: string) => removeCarEntry(id),
    (data, id) => applyEntryRemove(data, id),
    onError,
  );

  return {
    add: (payload: AddCarEntryPayload) => add.mutate({ ...payload, tempId: tempId() }),
    remove: (id: string) => remove.mutate(id),
  };
}

/**
 * Notepad autosave (blur-triggered, like the old carNotesSave). No toast on
 * failure — the old page surfaced "save failed" in the card's status line,
 * which the component derives from this mutation's state. The cache is
 * patched on success so the 5s poll doesn't flash stale text back.
 */
export function useSaveCarNotes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => saveCarNotes(text),
    onSuccess: (_result, text) => {
      const previous = queryClient.getQueryData<CarData>(CAR_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<CarData>(CAR_QUERY_KEY, applyNotesText(previous, text));
      }
    },
  });
}
