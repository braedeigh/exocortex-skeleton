import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  addMove,
  addRoutine,
  getMovementData,
  removeMove,
  removeRoutine,
  reorderMoves,
  updateMove,
  updateRoutine,
} from './api';
import type { AddMovePayload, MovePatch, RoutinePatch } from './api';
import {
  applyMoveAdd,
  applyMoveRemove,
  applyMoveReorder,
  applyMoveUpdate,
  applyRoutineAdd,
  applyRoutineRemove,
  applyRoutineUpdate,
} from './optimistic';
import type { MovementData, MovementMove, MovementRoutine } from './types';

export const MOVEMENT_QUERY_KEY = ['data', 'movement'] as const;

/** Primary data — same 5s poll cadence as the old dashboard's loadDashboard loop. */
export function useMovementData() {
  return useQuery({
    queryKey: MOVEMENT_QUERY_KEY,
    queryFn: ({ signal }) => getMovementData(signal),
    refetchInterval: 5000,
  });
}

/** Same shape as todos' useOptimisticMutation, over the movement cache key. */
function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: MovementData, vars: TVars) => MovementData,
  onError: (message: string) => void,
): UseMutationResult<unknown, unknown, TVars, { previous?: MovementData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: MOVEMENT_QUERY_KEY });
      const previous = queryClient.getQueryData<MovementData>(MOVEMENT_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<MovementData>(MOVEMENT_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(MOVEMENT_QUERY_KEY, context.previous);
      onError(err instanceof ApiError ? err.message : 'Save failed.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MOVEMENT_QUERY_KEY });
    },
  });
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

export interface MovementActions {
  addRoutine: (name: string, note: string) => void;
  updateRoutine: (id: string, patch: RoutinePatch) => void;
  removeRoutine: (id: string) => void;
  addMove: (routineId: string, payload: AddMovePayload) => void;
  updateMove: (routineId: string, id: string, patch: MovePatch) => void;
  removeMove: (routineId: string, id: string) => void;
  reorderMoves: (routineId: string, order: string[]) => void;
}

/** All movement mutations, each applying an optimistic cache write so the UI
 * answers instantly (the old tab awaited a full dashboard reload instead). */
export function useMovementActions(onError: (message: string) => void): MovementActions {
  const addRoutineM = useOptimisticMutation(
    (vars: { name: string; note: string; tempRoutine: MovementRoutine }) => addRoutine(vars.name, vars.note),
    (data, vars) => applyRoutineAdd(data, vars.tempRoutine),
    onError,
  );
  const updateRoutineM = useOptimisticMutation(
    (vars: { id: string; patch: RoutinePatch }) => updateRoutine(vars.id, vars.patch),
    (data, vars) => applyRoutineUpdate(data, vars.id, vars.patch),
    onError,
  );
  const removeRoutineM = useOptimisticMutation(
    (id: string) => removeRoutine(id),
    (data, id) => applyRoutineRemove(data, id),
    onError,
  );
  const addMoveM = useOptimisticMutation(
    (vars: { routineId: string; payload: AddMovePayload; tempMove: MovementMove }) =>
      addMove(vars.routineId, vars.payload),
    (data, vars) => applyMoveAdd(data, vars.routineId, vars.tempMove),
    onError,
  );
  const updateMoveM = useOptimisticMutation(
    (vars: { routineId: string; id: string; patch: MovePatch }) =>
      updateMove(vars.routineId, vars.id, vars.patch),
    (data, vars) => applyMoveUpdate(data, vars.routineId, vars.id, vars.patch),
    onError,
  );
  const removeMoveM = useOptimisticMutation(
    (vars: { routineId: string; id: string }) => removeMove(vars.routineId, vars.id),
    (data, vars) => applyMoveRemove(data, vars.routineId, vars.id),
    onError,
  );
  const reorderM = useOptimisticMutation(
    (vars: { routineId: string; order: string[] }) => reorderMoves(vars.routineId, vars.order),
    (data, vars) => applyMoveReorder(data, vars.routineId, vars.order),
    onError,
  );

  return {
    addRoutine: (name, note) =>
      addRoutineM.mutate({ name, note, tempRoutine: { id: tempId(), name, note, moves: [] } }),
    updateRoutine: (id, patch) => updateRoutineM.mutate({ id, patch }),
    removeRoutine: (id) => removeRoutineM.mutate(id),
    addMove: (routineId, payload) =>
      addMoveM.mutate({ routineId, payload, tempMove: { id: tempId(), ...payload } }),
    updateMove: (routineId, id, patch) => updateMoveM.mutate({ routineId, id, patch }),
    removeMove: (routineId, id) => removeMoveM.mutate({ routineId, id }),
    reorderMoves: (routineId, order) => reorderM.mutate({ routineId, order }),
  };
}
