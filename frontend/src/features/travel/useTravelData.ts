/**
 * useTravelData.ts — TanStack Query wiring for the Travel page. Same shape as
 * features/car/useCarData.ts: one polled query (5s) + optimistic mutations
 * that patch the cache instantly and reconcile via invalidate/poll. The
 * packed checkbox and the reckoning buttons are the hot paths — those must
 * feel instant while standing over a suitcase.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  addTrip,
  addTripItem,
  applyTemplate,
  removeTemplate,
  removeTrip,
  removeTripItem,
  saveTemplate,
  templateFromTrip,
  updateTrip,
  updateTripItem,
} from './api';
import type { AddItemPayload, AddTripPayload, UpdateItemPayload, UpdateTripPayload } from './api';
import { getTravelData } from './api';
import { appendItem, dropItem, dropTrip, patchItem, patchTrip } from './travelHelpers';
import type { TravelData, TripItem } from './types';

export const TRAVEL_QUERY_KEY = ['data', 'travel'] as const;

export function useTravelData() {
  return useQuery({
    queryKey: TRAVEL_QUERY_KEY,
    queryFn: ({ signal }) => getTravelData(signal),
    refetchInterval: 5000,
  });
}

function useOptimisticTravelMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: TravelData, vars: TVars) => TravelData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: TravelData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: TRAVEL_QUERY_KEY });
      const previous = queryClient.getQueryData<TravelData>(TRAVEL_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<TravelData>(TRAVEL_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(TRAVEL_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TRAVEL_QUERY_KEY });
    },
  });
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

export function useTravelActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: TRAVEL_QUERY_KEY });
  const toast = (err: unknown) =>
    onError(err instanceof ApiError ? err.message : 'Something went wrong');

  // Non-optimistic mutations (server assigns ids / merges) — settle then refetch.
  const addTripMut = useMutation({ mutationFn: addTrip, onError: toast, onSettled: invalidate });
  const applyTemplateMut = useMutation({
    mutationFn: (vars: { tripId: string; templateId: string }) =>
      applyTemplate(vars.tripId, vars.templateId),
    onError: toast,
    onSettled: invalidate,
  });
  const saveTemplateMut = useMutation({
    mutationFn: saveTemplate,
    onError: toast,
    onSettled: invalidate,
  });
  const templateFromTripMut = useMutation({
    mutationFn: (vars: { tripId: string; name: string }) =>
      templateFromTrip(vars.tripId, vars.name),
    onError: toast,
    onSettled: invalidate,
  });
  const removeTemplateMut = useMutation({
    mutationFn: removeTemplate,
    onError: toast,
    onSettled: invalidate,
  });

  // Optimistic — the taps that must not wait for the network.
  const updateTripMut = useOptimisticTravelMutation(
    (vars: UpdateTripPayload) => updateTrip(vars),
    (data, vars) => patchTrip(data, vars.id, vars),
    onError,
  );
  const removeTripMut = useOptimisticTravelMutation(
    (id: string) => removeTrip(id),
    (data, id) => dropTrip(data, id),
    onError,
  );
  const addItemMut = useOptimisticTravelMutation(
    (vars: AddItemPayload & { tempId: string }) => addTripItem(vars),
    (data, vars) =>
      appendItem(data, vars.trip_id, {
        id: vars.tempId,
        name: vars.name,
        source: vars.source ?? 'text',
        ref_id: vars.ref_id ?? '',
        category: vars.category ?? '',
        notes: vars.notes ?? '',
        packed: false,
        returned: '',
      } satisfies TripItem),
    onError,
  );
  const updateItemMut = useOptimisticTravelMutation(
    (vars: UpdateItemPayload) => updateTripItem(vars),
    (data, vars) => patchItem(data, vars.trip_id, vars.item_id, vars),
    onError,
  );
  const removeItemMut = useOptimisticTravelMutation(
    (vars: { tripId: string; itemId: string }) => removeTripItem(vars.tripId, vars.itemId),
    (data, vars) => dropItem(data, vars.tripId, vars.itemId),
    onError,
  );

  return {
    addTrip: (payload: AddTripPayload) => addTripMut.mutate(payload),
    updateTrip: (payload: UpdateTripPayload) => updateTripMut.mutate(payload),
    removeTrip: (id: string) => removeTripMut.mutate(id),
    addItem: (payload: AddItemPayload) => addItemMut.mutate({ ...payload, tempId: tempId() }),
    updateItem: (payload: UpdateItemPayload) => updateItemMut.mutate(payload),
    removeItem: (tripId: string, itemId: string) => removeItemMut.mutate({ tripId, itemId }),
    applyTemplate: (tripId: string, templateId: string) =>
      applyTemplateMut.mutate({ tripId, templateId }),
    saveTemplate: (payload: Parameters<typeof saveTemplate>[0]) => saveTemplateMut.mutate(payload),
    templateFromTrip: (tripId: string, name: string) =>
      templateFromTripMut.mutate({ tripId, name }),
    removeTemplate: (id: string) => removeTemplateMut.mutate(id),
  };
}
