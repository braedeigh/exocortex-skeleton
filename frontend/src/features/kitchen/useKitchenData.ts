/**
 * useKitchenData.ts — TanStack Query hooks for the kitchen tab: the main
 * /api/data/kitchen poll (5s, like useTodayData), the parsed-receipts /
 * parsed-recipes side queries, toasts, and optimistic mutations for the
 * interactions the old UI reflected instantly.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { ToastItem } from '../../ui';
import {
  addGrocery,
  addGroceryWithCategory,
  clearGroceryAll,
  clearGroceryChecked,
  getKitchenData,
  listParsedReceipts,
  listParsedRecipes,
  removeGrocery,
  removeRecipe,
  saveCatalogNote,
  saveCategoryOrder,
  saveRecipeMyNotes,
  setGroceryItemNote,
  setItemLocation,
  setSafetyTag,
  toggleGrocery,
} from './api';
import {
  applyAdd,
  applyCatalogNote,
  applyCategoryOrder,
  applyCheckAll,
  applyClearAll,
  applyClearChecked,
  applyGroceryNote,
  applyLocation,
  applyRecipeMyNotes,
  applyRecipeRemove,
  applyRemove,
  applySafetyTag,
  applyToggle,
} from './optimistic';
import type { KitchenData } from './types';

export const KITCHEN_QUERY_KEY = ['data', 'kitchen'] as const;
export const PARSED_RECEIPTS_KEY = ['kitchen', 'parsed-receipts'] as const;
export const PARSED_RECIPES_KEY = ['kitchen', 'parsed-recipes'] as const;

export function useKitchenData() {
  return useQuery({
    queryKey: KITCHEN_QUERY_KEY,
    queryFn: ({ signal }) => getKitchenData(signal),
    refetchInterval: 5000,
  });
}

/** Parsed-but-unimported receipts. The old page fetched once per load and
 * after imports; a slow poll keeps the "ready to import" banner live while
 * Claude parses in the background. */
export function useParsedReceipts() {
  return useQuery({
    queryKey: PARSED_RECEIPTS_KEY,
    queryFn: ({ signal }) => listParsedReceipts(signal),
    refetchInterval: 20000,
  });
}

export function useParsedRecipes() {
  return useQuery({
    queryKey: PARSED_RECIPES_KEY,
    queryFn: ({ signal }) => listParsedRecipes(signal),
    refetchInterval: 20000,
  });
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, tone: 'error' | 'info' = 'error') => {
    const id = nextId.current++;
    setToasts((cur) => [...cur, { id, message, tone }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 6000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: KitchenData, vars: TVars) => KitchenData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: KitchenData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: KITCHEN_QUERY_KEY });
      const previous = queryClient.getQueryData<KitchenData>(KITCHEN_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<KitchenData>(KITCHEN_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(KITCHEN_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: KITCHEN_QUERY_KEY });
    },
  });
}

/** Refetch the main kitchen payload — the React stand-in for loadDashboard(). */
export function useInvalidateKitchen() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: KITCHEN_QUERY_KEY });
  }, [queryClient]);
}

export function useGroceryActions(onError: (message: string) => void) {
  const toggle = useOptimisticMutation((name: string) => toggleGrocery(name), applyToggle, onError);
  const remove = useOptimisticMutation((name: string) => removeGrocery(name), applyRemove, onError);
  const add = useOptimisticMutation(
    (vars: { name: string; category?: string }) => addGrocery(vars.name, vars.category),
    (data, vars) => applyAdd(data, vars.name, vars.category),
    onError,
  );
  const addWithCategory = useOptimisticMutation(
    (vars: { name: string; category: string }) => addGroceryWithCategory(vars.name, vars.category),
    (data, vars) => applyAdd(data, vars.name, vars.category),
    onError,
  );
  const clearChecked = useOptimisticMutation(() => clearGroceryChecked(), applyClearChecked, onError);
  const clearAll = useOptimisticMutation(() => clearGroceryAll(), applyClearAll, onError);
  // "Mark all purchased" — the endpoint toggles one item at a time, so the
  // mutationFn walks the unchecked names while the cache flips all at once.
  const checkAll = useOptimisticMutation(
    async (names: string[]) => {
      for (const name of names) {
        await toggleGrocery(name);
      }
    },
    (data) => applyCheckAll(data),
    onError,
  );
  const noteMut = useOptimisticMutation(
    (vars: { name: string; note: string }) => setGroceryItemNote(vars.name, vars.note),
    (data, vars) => applyGroceryNote(data, vars.name, vars.note),
    onError,
  );
  const safety = useOptimisticMutation(
    (vars: { name: string; tag: string }) => setSafetyTag(vars.name, vars.tag),
    (data, vars) => applySafetyTag(data, vars.name, vars.tag),
    onError,
  );
  const locationMut = useOptimisticMutation(
    (vars: { name: string; location: string }) => setItemLocation(vars.name, vars.location),
    (data, vars) => applyLocation(data, vars.name, vars.location),
    onError,
  );
  const categoryOrder = useOptimisticMutation(
    (order: string[]) => saveCategoryOrder(order),
    (data, order) => applyCategoryOrder(data, order),
    onError,
  );
  const catalogNote = useOptimisticMutation(
    (vars: { name: string; note: string }) => saveCatalogNote(vars.name, vars.note),
    (data, vars) => applyCatalogNote(data, vars.name, vars.note),
    onError,
  );

  return {
    toggle: (name: string) => toggle.mutateAsync(name),
    remove: (name: string) => remove.mutate(name),
    add: (name: string, category?: string) => add.mutateAsync({ name, category }),
    addWithCategory: (name: string, category: string) => addWithCategory.mutateAsync({ name, category }),
    clearChecked: () => clearChecked.mutate(undefined as unknown as void),
    clearAll: () => clearAll.mutate(undefined as unknown as void),
    checkAll: (names: string[]) => checkAll.mutateAsync(names),
    note: (name: string, note: string) => noteMut.mutate({ name, note }),
    safety: (name: string, tag: string) => safety.mutate({ name, tag }),
    location: (name: string, location: string) => locationMut.mutate({ name, location }),
    categoryOrder: (order: string[]) => categoryOrder.mutateAsync(order),
    catalogNote: (name: string, note: string) => catalogNote.mutate({ name, note }),
  };
}

export function useRecipeActions(onError: (message: string) => void) {
  const myNotes = useOptimisticMutation(
    (vars: { id: string; myNotes: string }) => saveRecipeMyNotes(vars.id, vars.myNotes),
    (data, vars) => applyRecipeMyNotes(data, vars.id, vars.myNotes),
    onError,
  );
  const remove = useOptimisticMutation(
    (id: string) => removeRecipe(id),
    (data, id) => applyRecipeRemove(data, id),
    onError,
  );
  return {
    saveMyNotes: (id: string, notes: string) => myNotes.mutateAsync({ id, myNotes: notes }),
    remove: (id: string) => remove.mutate(id),
  };
}
