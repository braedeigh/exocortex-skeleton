/**
 * useHousingData.ts — TanStack Query hooks for the housing tab, following
 * features/todos/useTodayData.ts: one polled query (5s, matching the old
 * dashboard render loop) + optimistic mutations against the same cache key.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { ToastItem } from '../../ui';
import {
  addHousingPlace,
  getHousingData,
  removeHousingPlace,
  saveHousingNotes,
  updateHousingPlace,
} from './api';
import { normalizeStatus } from './statusLadder';
import type { HousingEntry, HousingResponse, PlaceFields } from './types';

export const HOUSING_QUERY_KEY = ['data', 'housing'] as const;

export function useHousingData() {
  return useQuery({
    queryKey: HOUSING_QUERY_KEY,
    queryFn: ({ signal }) => getHousingData(signal),
    refetchInterval: 5000,
  });
}

export interface PushOptions {
  tone?: 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

/** Error + undo toasts (same shape as journal's useToasts). */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, opts?: PushOptions) => {
    const id = nextId.current++;
    setToasts((cur) => [
      ...cur,
      { id, message, tone: opts?.tone ?? 'error', actionLabel: opts?.actionLabel, onAction: opts?.onAction },
    ]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), opts?.duration ?? 5000);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: HousingResponse, vars: TVars) => HousingResponse,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: HousingResponse }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: HOUSING_QUERY_KEY });
      const previous = queryClient.getQueryData<HousingResponse>(HOUSING_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<HousingResponse>(HOUSING_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(HOUSING_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: HOUSING_QUERY_KEY });
    },
  });
}

// --- pure cache updaters (in public mode `housing` is absent — no-op) ---

function withEntries(
  data: HousingResponse,
  map: (entries: HousingEntry[]) => HousingEntry[],
): HousingResponse {
  if (!data.housing) return data;
  return { ...data, housing: { ...data.housing, entries: map(data.housing.entries ?? []) } };
}

function applyPatch(data: HousingResponse, id: string, patch: Partial<PlaceFields>): HousingResponse {
  return withEntries(data, (entries) => entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

function applyAdd(data: HousingResponse, entry: HousingEntry): HousingResponse {
  return withEntries(data, (entries) => [...entries, entry]);
}

function applyRemove(data: HousingResponse, id: string): HousingResponse {
  return withEntries(data, (entries) => entries.filter((e) => e.id !== id));
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

/** Mirror routes/housing.py's add-side normalization so the optimistic entry
 * matches what the server persists (trim, name fallback, status ladder). */
function cleanFields(fields: PlaceFields): PlaceFields {
  return {
    name: fields.name.trim() || 'Untitled place',
    link: fields.link.trim(),
    rent: fields.rent.trim(),
    size: fields.size.trim(),
    area: fields.area.trim(),
    status: normalizeStatus(fields.status.trim()),
    avail: fields.avail.trim(),
    notes: fields.notes.trim(),
  };
}

export function useHousingActions(onError: (message: string) => void) {
  const add = useOptimisticMutation(
    (vars: { tempEntry: HousingEntry }) => {
      const { tempEntry } = vars;
      const { id: _id, ...fields } = tempEntry;
      return addHousingPlace(fields);
    },
    (data, vars) => applyAdd(data, vars.tempEntry),
    onError,
  );
  const update = useOptimisticMutation(
    (vars: { id: string; patch: Partial<PlaceFields> }) => updateHousingPlace({ id: vars.id, ...vars.patch }),
    (data, vars) => applyPatch(data, vars.id, vars.patch),
    onError,
  );
  const remove = useOptimisticMutation(
    (id: string) => removeHousingPlace(id),
    (data, id) => applyRemove(data, id),
    onError,
  );

  return {
    add: (fields: PlaceFields) => add.mutate({ tempEntry: { id: tempId(), ...cleanFields(fields) } }),
    /** Status dropdown on a card — sends only {id, status} like the old JS. */
    setStatus: (id: string, status: string) => update.mutate({ id, patch: { status } }),
    /** Inline-edit Save — full field set. */
    saveEdit: (id: string, fields: PlaceFields) => update.mutate({ id, patch: fields }),
    remove: (id: string) => remove.mutate(id),
  };
}

/**
 * Criteria-&-plan notes save. Not optimistic in the usual sense — the
 * textarea holds a local draft while editing — but on success the cache's
 * copy is patched so the 5s poll doesn't flash stale text back.
 */
export function useSaveNotes(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => saveHousingNotes(text),
    onError: (err) => {
      onError(err instanceof ApiError ? err.message : 'Could not save notes.');
    },
    onSuccess: (_res, text) => {
      const cur = queryClient.getQueryData<HousingResponse>(HOUSING_QUERY_KEY);
      if (cur?.housing) {
        queryClient.setQueryData<HousingResponse>(HOUSING_QUERY_KEY, {
          ...cur,
          housing: { ...cur.housing, notes: text },
        });
      }
    },
  });
}
