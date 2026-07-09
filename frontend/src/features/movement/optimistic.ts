/** Pure cache updaters for the movement query — mirror routes/movement.py so
 * optimistic writes match what the next poll will return. All immutable. */
import type { MovementData, MovementMove, MovementRoutine } from './types';
import type { MovePatch, RoutinePatch } from './api';

function routinesOf(data: MovementData): MovementRoutine[] {
  return data.movement?.routines ?? [];
}

function withRoutines(data: MovementData, routines: MovementRoutine[]): MovementData {
  return { ...data, movement: { ...(data.movement ?? {}), routines } };
}

function mapRoutine(
  data: MovementData,
  routineId: string,
  fn: (r: MovementRoutine) => MovementRoutine,
): MovementData {
  return withRoutines(
    data,
    routinesOf(data).map((r) => (r.id === routineId ? fn(r) : r)),
  );
}

export function applyRoutineAdd(data: MovementData, routine: MovementRoutine): MovementData {
  return withRoutines(data, [...routinesOf(data), routine]);
}

export function applyRoutineUpdate(data: MovementData, id: string, patch: RoutinePatch): MovementData {
  return mapRoutine(data, id, (r) => ({ ...r, ...patch }));
}

export function applyRoutineRemove(data: MovementData, id: string): MovementData {
  return withRoutines(
    data,
    routinesOf(data).filter((r) => r.id !== id),
  );
}

export function applyMoveAdd(data: MovementData, routineId: string, move: MovementMove): MovementData {
  return mapRoutine(data, routineId, (r) => ({ ...r, moves: [...(r.moves ?? []), move] }));
}

export function applyMoveUpdate(
  data: MovementData,
  routineId: string,
  moveId: string,
  patch: MovePatch,
): MovementData {
  return mapRoutine(data, routineId, (r) => ({
    ...r,
    moves: (r.moves ?? []).map((m) => (m.id === moveId ? { ...m, ...patch } : m)),
  }));
}

export function applyMoveRemove(data: MovementData, routineId: string, moveId: string): MovementData {
  return mapRoutine(data, routineId, (r) => ({
    ...r,
    moves: (r.moves ?? []).filter((m) => m.id !== moveId),
  }));
}

/** Same semantics as the reorder route: moves named in `order` first (in that
 * order), any not named keep their place at the end. */
export function applyMoveReorder(data: MovementData, routineId: string, order: string[]): MovementData {
  return mapRoutine(data, routineId, (r) => {
    const byId = new Map((r.moves ?? []).map((m) => [m.id, m]));
    const reordered: MovementMove[] = [];
    for (const id of order) {
      const m = byId.get(id);
      if (m) {
        reordered.push(m);
        byId.delete(id);
      }
    }
    reordered.push(...byId.values());
    return { ...r, moves: reordered };
  });
}
