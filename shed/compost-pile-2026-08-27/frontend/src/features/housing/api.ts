/**
 * api.ts — housing endpoints over the shared fetch client.
 *
 * Backend: routes/housing.py (+ the /api/data/housing aggregate in
 * server.py). Same URLs the old static/js/housing.js called.
 */
import { api } from '../../api/client';
import type { HousingResponse, PlaceFields } from './types';

export function getHousingData(signal?: AbortSignal): Promise<HousingResponse> {
  return api.get<HousingResponse>('/api/data/housing', signal);
}

export function addHousingPlace(fields: PlaceFields): Promise<{ ok: boolean; id: string }> {
  return api.post<{ ok: boolean; id: string }>('/api/housing/add', fields);
}

export function updateHousingPlace(
  payload: { id: string } & Partial<PlaceFields>,
): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/housing/update', payload);
}

export function removeHousingPlace(id: string): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/housing/remove', { id });
}

export function saveHousingNotes(text: string): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/housing/notes/save', { text });
}
