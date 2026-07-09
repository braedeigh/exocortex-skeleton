import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { ToastItem } from '../../ui';
import {
  foodTestCancel,
  foodTestClearBaseline,
  foodTestExtend,
  foodTestLogRetro,
  foodTestOutcome,
  foodTestQueueAdd,
  foodTestQueueRemove,
  foodTestQueueReorder,
  foodTestStart,
  getBodyData,
  logFood,
  logSymptoms,
  saveSymptomDefinitions,
  setFoodNotes,
  setSafetyTag,
} from './bodyApi';
import type { SymptomPayload } from './bodyApi';
import { applyFoodAppend, applyFoodNotes, applyQueue, applySafetyTag, applySymptoms } from './optimistic';
import { joinFoods } from './foodLogHelpers';
import type { BodyData, FoodTestOutcome, SafetyTag, SymptomDefinitions } from './types';

export const BODY_QUERY_KEY = ['data', 'body'] as const;

/** Primary Body-tab stream — polled every 5s like the old dashboard. */
export function useBodyData() {
  return useQuery({
    queryKey: BODY_QUERY_KEY,
    queryFn: ({ signal }) => getBodyData(signal),
    refetchInterval: 5000,
  });
}

export interface PushToastOptions {
  tone?: 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
}

/** Like todos' useToasts, but supports the info tone + Undo action pairing
 * (ToastStack already renders both). */
export function useBodyToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, opts?: PushToastOptions) => {
    const id = nextId.current++;
    setToasts((cur) => [...cur, { id, message, ...opts }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: BodyData, vars: TVars) => BodyData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: BodyData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: BODY_QUERY_KEY });
      const previous = queryClient.getQueryData<BodyData>(BODY_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<BodyData>(BODY_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(BODY_QUERY_KEY, context.previous);
      onError(errorMessage(err));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BODY_QUERY_KEY });
    },
  });
}

/** Symptom + food-notes mutations (dot grid, day editor, food log). */
export function useSymptomFoodActions(onError: (message: string) => void) {
  const symptoms = useOptimisticMutation(
    (vars: { date: string; symptoms: SymptomPayload }) => logSymptoms(vars.date, vars.symptoms),
    (data, vars) => applySymptoms(data, vars.date, vars.symptoms),
    onError,
  );
  const setFood = useOptimisticMutation(
    (vars: { date: string; foods: string[] }) => setFoodNotes(vars.date, joinFoods(vars.foods)),
    (data, vars) => applyFoodNotes(data, vars.date, joinFoods(vars.foods)),
    onError,
  );
  const addFood = useOptimisticMutation(
    (vars: { food: string; serverDate: string }) => logFood(vars.food),
    (data, vars) => applyFoodAppend(data, vars.serverDate, vars.food),
    onError,
  );

  return {
    logSymptoms: (date: string, payload: SymptomPayload) => symptoms.mutate({ date, symptoms: payload }),
    setFood: (date: string, foods: string[]) => setFood.mutate({ date, foods }),
    addFood: (food: string, serverDate: string) => addFood.mutate({ food, serverDate }),
  };
}

/** Safety-tag mutations (triage buttons, chip clouds, drag/drop). */
export function useSafetyTagActions(onError: (message: string) => void) {
  const setTag = useOptimisticMutation(
    (vars: { name: string; tag: SafetyTag | '' }) => setSafetyTag(vars.name, vars.tag),
    (data, vars) => applySafetyTag(data, vars.name, vars.tag),
    onError,
  );

  return {
    setTag: (name: string, tag: SafetyTag | '') => setTag.mutate({ name, tag }),
  };
}

/** Symptom-definitions save — updates both the body cache and the shared
 * ['data','symptom-definitions'] cache the todos SymptomCard tooltips read. */
export function useDefinitionActions(onError: (message: string) => void, onSaved?: () => void) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (definitions: SymptomDefinitions) => saveSymptomDefinitions(definitions),
    onSuccess: (_res, definitions) => {
      queryClient.setQueryData<BodyData>(BODY_QUERY_KEY, (cur) =>
        cur ? { ...cur, symptom_definitions: definitions } : cur,
      );
      queryClient.setQueryData(['data', 'symptom-definitions'], definitions);
      onSaved?.();
    },
    onError: (err) => onError(errorMessage(err)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BODY_QUERY_KEY });
    },
  });
  return { save: (definitions: SymptomDefinitions) => save.mutate(definitions) };
}

/**
 * Food-experiment mutations. The lifecycle endpoints (start/outcome/extend/
 * cancel/clear-baseline/log-retro) are NOT optimistic — the state machine
 * (one active test, recovery gating, auto-tagging) lives server-side and its
 * refusals ("A test is already active") must surface, so we invalidate and
 * let the poll pick up the result. Queue edits are optimistic.
 */
export function useExperimentActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: BODY_QUERY_KEY });
  const onErr = (err: unknown) => onError(errorMessage(err));

  const start = useMutation({
    mutationFn: (food: string) => foodTestStart(food),
    onError: onErr,
    onSettled: invalidate,
  });
  const outcome = useMutation({
    mutationFn: (vars: { id: string; outcome: FoodTestOutcome; flareNotes: string }) =>
      foodTestOutcome(vars.id, vars.outcome, vars.flareNotes),
    onError: onErr,
    onSettled: invalidate,
  });
  const extend = useMutation({
    mutationFn: (vars: { id: string; days: number }) => foodTestExtend(vars.id, vars.days),
    onError: onErr,
    onSettled: invalidate,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => foodTestCancel(id),
    onError: onErr,
    onSettled: invalidate,
  });
  const clearBaseline = useMutation({
    mutationFn: () => foodTestClearBaseline(),
    onError: onErr,
    onSettled: invalidate,
  });
  const logRetro = useMutation({
    mutationFn: (vars: { food: string; flareNotes: string }) => foodTestLogRetro(vars.food, vars.flareNotes),
    onError: onErr,
    onSettled: invalidate,
  });

  const queueAdd = useMutation({
    mutationFn: (food: string) => foodTestQueueAdd(food),
    onError: (err) => onError(errorMessage(err)),
    onSettled: invalidate,
  });
  const queueRemove = useOptimisticMutation(
    (food: string) => foodTestQueueRemove(food),
    (data, food) =>
      applyQueue(data, (data.food_test_queue || []).filter((f) => f.toLowerCase() !== food.toLowerCase())),
    onError,
  );
  const queueReorder = useOptimisticMutation(
    (order: string[]) => foodTestQueueReorder(order),
    (data, order) => applyQueue(data, order),
    onError,
  );

  return {
    start: (food: string) => start.mutate(food),
    resolve: (id: string, o: FoodTestOutcome, flareNotes: string) =>
      outcome.mutate({ id, outcome: o, flareNotes }),
    extend: (id: string, days: number) => extend.mutate({ id, days }),
    cancel: (id: string) => cancel.mutate(id),
    clearBaseline: () => clearBaseline.mutate(),
    logRetro: (food: string, flareNotes: string) => logRetro.mutate({ food, flareNotes }),
    queueAdd: (food: string) => queueAdd.mutate(food),
    queueRemove: (food: string) => queueRemove.mutate(food),
    queueReorder: (order: string[]) => queueReorder.mutate(order),
  };
}
