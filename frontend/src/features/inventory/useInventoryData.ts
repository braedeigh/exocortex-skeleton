/**
 * TanStack Query plumbing for the Inventory tab — same pattern as
 * features/todos/useTodayData.ts: one polled query (5s, the old core.js
 * render-loop cadence) + optimistic mutations that mirror the server's
 * writes, rolled back and re-invalidated on error.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  INVENTORY_QUERY_KEY,
  addArchival,
  addArchivalPhotos,
  addBuyItem,
  getInventoryData,
  moveBuyToActive,
  removeActiveItem,
  removeArchival,
  removeArchivalPhoto,
  removeBuyItem,
  restockActive,
  retireActive,
  setMainArchivalPhoto,
  unretireActive,
  updateActiveReview,
  updateArchival,
  updateBuyItem,
} from './api';
import type { AddBuyPayload, ArchivalFieldsPayload, UpdateBuyPayload } from './api';
import {
  applyActiveRemove,
  applyActiveReview,
  applyArchivalRemove,
  applyBuyRemove,
  applyBuySetKind,
  applyBuyUpdate,
  applyMarkBought,
  applyRestock,
  applyRetire,
  applyUnretire,
} from './optimistic';
import type { InventoryData } from './types';

export { INVENTORY_QUERY_KEY };
// The toast plumbing is identical to the todos page's — reuse it.
export { useToasts } from '../todos/useTodayData';

export function useInventoryData() {
  return useQuery({
    queryKey: INVENTORY_QUERY_KEY,
    queryFn: ({ signal }) => getInventoryData(signal),
    refetchInterval: 5000,
  });
}

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: InventoryData, vars: TVars) => InventoryData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: InventoryData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: INVENTORY_QUERY_KEY });
      const previous = queryClient.getQueryData<InventoryData>(INVENTORY_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<InventoryData>(INVENTORY_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(INVENTORY_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INVENTORY_QUERY_KEY });
    },
  });
}

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

export interface InventoryActions {
  /** Buy add — awaited so the form only clears on success (old addBuyItem
   * alerted the server's "Already on the list" and kept the inputs). */
  addBuy: (payload: AddBuyPayload) => Promise<void>;
  /** Buy modal/detail save — optimistic, but awaited so the modal closes only on success. */
  updateBuy: (payload: UpdateBuyPayload) => Promise<void>;
  removeBuy: (name: string) => void;
  setBuyKind: (name: string, kind: string) => void;
  markBought: (name: string) => void;
  restock: (name: string) => void;
  retire: (name: string, review: string) => void;
  unretire: (name: string) => void;
  removeActive: (name: string) => void;
  editReview: (name: string, review: string) => void;
  saveArchivalAdd: (fields: ArchivalFieldsPayload, photos: File[]) => Promise<void>;
  saveArchivalUpdate: (id: string, fields: ArchivalFieldsPayload) => Promise<void>;
  removeArchival: (id: string) => void;
  /** Photo edits change server state the open modal renders from — these
   * await a refetch (the old _archReloadAndReopen) so the modal repaints. */
  addPhotos: (itemId: string, photos: File[]) => Promise<void>;
  removePhoto: (itemId: string, photoId: string) => Promise<void>;
  setMainPhoto: (itemId: string, photoId: string) => Promise<void>;
}

export function useInventoryActions(onError: (message: string) => void): InventoryActions {
  const queryClient = useQueryClient();

  const removeBuy = useOptimisticMutation(
    (name: string) => removeBuyItem(name),
    (data, name) => applyBuyRemove(data, name),
    onError,
  );
  const update = useOptimisticMutation(
    (payload: UpdateBuyPayload) => updateBuyItem(payload),
    (data, payload) => applyBuyUpdate(data, payload),
    onError,
  );
  const setKind = useOptimisticMutation(
    (vars: { name: string; kind: string }) => updateBuyItem({ name: vars.name, kind: vars.kind }),
    (data, vars) => applyBuySetKind(data, vars.name, vars.kind),
    onError,
  );
  const bought = useOptimisticMutation(
    (name: string) => moveBuyToActive(name),
    (data, name) => applyMarkBought(data, name, todayStr()),
    onError,
  );
  const restock = useOptimisticMutation(
    (name: string) => restockActive(name),
    (data, name) => applyRestock(data, name, nowIso()),
    onError,
  );
  const retire = useOptimisticMutation(
    (vars: { name: string; review: string }) => retireActive(vars.name, vars.review),
    (data, vars) => applyRetire(data, vars.name, vars.review, todayStr()),
    onError,
  );
  const unretire = useOptimisticMutation(
    (name: string) => unretireActive(name),
    (data, name) => applyUnretire(data, name),
    onError,
  );
  const removeActive = useOptimisticMutation(
    (name: string) => removeActiveItem(name),
    (data, name) => applyActiveRemove(data, name),
    onError,
  );
  const editReview = useOptimisticMutation(
    (vars: { name: string; review: string }) => updateActiveReview(vars.name, vars.review),
    (data, vars) => applyActiveReview(data, vars.name, vars.review),
    onError,
  );
  const removeArch = useOptimisticMutation(
    (id: string) => removeArchival(id),
    (data, id) => applyArchivalRemove(data, id),
    onError,
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: INVENTORY_QUERY_KEY });
  const refetch = () => queryClient.refetchQueries({ queryKey: INVENTORY_QUERY_KEY });

  return {
    addBuy: async (payload) => {
      try {
        await addBuyItem(payload);
      } catch (err) {
        // Callers swallow the rethrow (keeping the form inputs), so the toast
        // has to happen here — otherwise a failed add is silent.
        onError(err instanceof ApiError ? err.message : "Couldn't add to the buy list");
        throw err;
      }
      await invalidate();
    },
    updateBuy: (payload) => update.mutateAsync(payload).then(() => undefined),
    removeBuy: (name) => removeBuy.mutate(name),
    setBuyKind: (name, kind) => setKind.mutate({ name, kind }),
    markBought: (name) => bought.mutate(name),
    restock: (name) => restock.mutate(name),
    retire: (name, review) => retire.mutate({ name, review }),
    unretire: (name) => unretire.mutate(name),
    removeActive: (name) => removeActive.mutate(name),
    editReview: (name, review) => editReview.mutate({ name, review }),
    saveArchivalAdd: async (fields, photos) => {
      await addArchival(fields, photos);
      await invalidate();
    },
    saveArchivalUpdate: async (id, fields) => {
      await updateArchival(id, fields);
      await invalidate();
    },
    removeArchival: (id) => removeArch.mutate(id),
    addPhotos: async (itemId, photos) => {
      await addArchivalPhotos(itemId, photos);
      await refetch();
    },
    removePhoto: async (itemId, photoId) => {
      await removeArchivalPhoto(itemId, photoId);
      await refetch();
    },
    setMainPhoto: async (itemId, photoId) => {
      await setMainArchivalPhoto(itemId, photoId);
      await refetch();
    },
  };
}
