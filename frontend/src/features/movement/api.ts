/** Movement endpoints (routes/movement.py) over the shared fetch client.
 * Kept feature-local — nothing outside features/movement calls these. */
import { api } from '../../api/client';
import type { MovementData } from './types';

interface OkResponse {
  ok: boolean;
}

interface OkIdResponse extends OkResponse {
  id: string;
}

/** GET /api/data/movement — routines plus common dashboard data; polled every 5s. */
export function getMovementData(signal?: AbortSignal): Promise<MovementData> {
  return api.get('/api/data/movement', signal);
}

// --- Routines ---

export function addRoutine(name: string, note: string): Promise<OkIdResponse> {
  return api.post('/api/movement/routine/add', { name, note });
}

export interface RoutinePatch {
  name?: string;
  note?: string;
}

/** Only the fields present in the patch are updated server-side. */
export function updateRoutine(id: string, patch: RoutinePatch): Promise<OkResponse> {
  return api.post('/api/movement/routine/update', { id, ...patch });
}

export function removeRoutine(id: string): Promise<OkResponse> {
  return api.post('/api/movement/routine/remove', { id });
}

// --- Moves (within a routine) ---

export interface AddMovePayload {
  name: string;
  dose: string;
  url: string;
  note: string;
}

export function addMove(routineId: string, payload: AddMovePayload): Promise<OkIdResponse> {
  return api.post('/api/movement/move/add', { routine_id: routineId, ...payload });
}

export interface MovePatch {
  name?: string;
  dose?: string;
  url?: string;
  note?: string;
}

export function updateMove(routineId: string, id: string, patch: MovePatch): Promise<OkResponse> {
  return api.post('/api/movement/move/update', { routine_id: routineId, id, ...patch });
}

export function removeMove(routineId: string, id: string): Promise<OkResponse> {
  return api.post('/api/movement/move/remove', { routine_id: routineId, id });
}

export function reorderMoves(routineId: string, order: string[]): Promise<OkResponse> {
  return api.post('/api/movement/move/reorder', { routine_id: routineId, order });
}
