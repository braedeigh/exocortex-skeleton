/**
 * useBuildData.ts — react-query wiring for the build queue.
 *
 * One query holds both halves (cards + the legacy markdown sections); every
 * mutation invalidates it. Edits and status flips are optimistic so a tap on
 * "shipped" moves the card immediately instead of waiting for the round trip;
 * a failure rolls the cache back and toasts the server's reason.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  addBuildCard,
  getBuildQueue,
  removeBuildCard,
  restoreBuildCard,
  updateBuildCard,
} from './api';
import type { BuildCard, BuildCardPatch, BuildQueue, NewBuildCard } from './api';

export const BUILD_QUEUE_KEY = ['buildQueue'] as const;

/** Same cadence as the other dashboard surfaces (Ideas, todos). */
const POLL_MS = 5000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function useBuildQueue(enabled = true) {
  return useQuery({
    queryKey: BUILD_QUEUE_KEY,
    queryFn: ({ signal }) => getBuildQueue(signal),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useBuildMutations(
  onError: (message: string) => void,
  onRemoved: (card: BuildCard, undo: () => void) => void,
) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: BUILD_QUEUE_KEY });
  };

  const add = useMutation({
    mutationFn: (card: NewBuildCard) => addBuildCard(card),
    onError: (err) => onError(errorMessage(err, "Couldn't file that")),
    onSuccess: () => invalidate(),
  });

  const update = useMutation({
    mutationFn: (vars: { id: string; patch: BuildCardPatch }) => updateBuildCard(vars.id, vars.patch),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: BUILD_QUEUE_KEY });
      const previous = queryClient.getQueryData<BuildQueue>(BUILD_QUEUE_KEY);
      if (previous) {
        queryClient.setQueryData<BuildQueue>(BUILD_QUEUE_KEY, {
          ...previous,
          cards: previous.cards.map((c) => (c.id === vars.id ? { ...c, ...vars.patch } : c)),
        });
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(BUILD_QUEUE_KEY, context.previous);
      onError(errorMessage(err, "Couldn't save that"));
    },
    onSettled: () => invalidate(),
  });

  const restore = useMutation({
    mutationFn: (card: BuildCard) => restoreBuildCard(card),
    onError: (err) => onError(errorMessage(err, "Couldn't restore that")),
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeBuildCard(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: BUILD_QUEUE_KEY });
      const previous = queryClient.getQueryData<BuildQueue>(BUILD_QUEUE_KEY);
      const removed = previous?.cards.find((c) => c.id === id) ?? null;
      if (previous) {
        queryClient.setQueryData<BuildQueue>(BUILD_QUEUE_KEY, {
          ...previous,
          cards: previous.cards.filter((c) => c.id !== id),
        });
      }
      return { previous, removed };
    },
    onError: (err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(BUILD_QUEUE_KEY, context.previous);
      onError(errorMessage(err, "Couldn't delete that"));
    },
    onSuccess: (_data, _id, context) => {
      // Undo re-POSTs the whole card, so the id and mint date survive exactly.
      const removed = context?.removed;
      if (removed) onRemoved(removed, () => restore.mutate(removed));
    },
    onSettled: () => invalidate(),
  });

  return {
    add: (card: NewBuildCard) => add.mutate(card),
    update: (id: string, patch: BuildCardPatch) => update.mutate({ id, patch }),
    remove: (id: string) => remove.mutate(id),
  };
}
