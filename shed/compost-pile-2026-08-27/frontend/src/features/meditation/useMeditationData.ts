/**
 * useMeditationData.ts — TanStack Query wiring for the Meditation tab.
 * Same shape as features/todos/useTodayData.ts: one polled query (5s, the
 * old loadDashboard cadence) + optimistic mutations rolled back on error.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  addDeityProfile,
  addMeditationEntry,
  getMeditationData,
  removeDeityProfile,
  removeMeditationEntry,
  updateDeityProfile,
} from './api';
import type { AddEntryPayload, DeityPayload } from './api';
import type { DeityProfile, MeditationData, MeditationEntry } from './types';

export const MEDITATION_QUERY_KEY = ['data', 'meditation'] as const;

export function useMeditationData() {
  return useQuery({
    queryKey: MEDITATION_QUERY_KEY,
    queryFn: ({ signal }) => getMeditationData(signal),
    refetchInterval: 5000,
  });
}

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: MeditationData, vars: TVars) => MeditationData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: MeditationData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: MEDITATION_QUERY_KEY });
      const previous = queryClient.getQueryData<MeditationData>(MEDITATION_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<MeditationData>(MEDITATION_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(MEDITATION_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MEDITATION_QUERY_KEY });
    },
  });
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

function withEntries(data: MeditationData, entries: MeditationEntry[]): MeditationData {
  return { ...data, meditation_log: { ...(data.meditation_log || {}), entries } };
}

function withProfiles(data: MeditationData, profiles: DeityProfile[]): MeditationData {
  return { ...data, deity_profiles: { ...(data.deity_profiles || {}), profiles } };
}

/** Practice-stream mutations: add cell / remove cell, both instant. */
export function usePracticeActions(onError: (message: string) => void) {
  const add = useOptimisticMutation(
    (vars: AddEntryPayload & { tempItem: MeditationEntry }) =>
      addMeditationEntry({ types: vars.types, date: vars.date, duration_min: vars.duration_min, notes: vars.notes }),
    (data, vars) => withEntries(data, [...(data.meditation_log?.entries || []), vars.tempItem]),
    onError,
  );
  const remove = useOptimisticMutation(
    (id: string) => removeMeditationEntry(id),
    (data, id) => withEntries(data, (data.meditation_log?.entries || []).filter((e) => e.id !== id)),
    onError,
  );

  return {
    add: (payload: AddEntryPayload) => {
      const tempItem: MeditationEntry = { id: tempId(), ...payload };
      add.mutate({ ...payload, tempItem });
    },
    remove: (id: string) => remove.mutate(id),
  };
}

/**
 * Deity mutations. `save` is NOT optimistic — the old page also waited for
 * the server before switching to the detail view (a new profile's id only
 * exists in the response). `remove` filters the cache instantly.
 */
export function useDeityActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: async (vars: { id: string | null; payload: DeityPayload }): Promise<string> => {
      if (vars.id) {
        await updateDeityProfile(vars.id, vars.payload);
        return vars.id;
      }
      const res = await addDeityProfile(vars.payload);
      return res.id;
    },
    onError: (err) => {
      onError(err instanceof ApiError ? err.message : 'Save failed.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MEDITATION_QUERY_KEY });
    },
  });

  const remove = useOptimisticMutation(
    (id: string) => removeDeityProfile(id),
    (data, id) => withProfiles(data, (data.deity_profiles?.profiles || []).filter((p) => p.id !== id)),
    onError,
  );

  return {
    /** Resolves to the profile's (possibly new) id, rejects on failure. */
    save: (id: string | null, payload: DeityPayload) => save.mutateAsync({ id, payload }),
    remove: (id: string) => remove.mutate(id),
  };
}
