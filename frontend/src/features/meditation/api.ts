/**
 * api.ts — feature-local endpoint helpers over the shared client.
 * Endpoints match static/js/meditation.js + routes/meditation.py exactly.
 */

import { api } from '../../api/client';
import type { DeityLink, MeditationData } from './types';

export function getMeditationData(signal?: AbortSignal): Promise<MeditationData> {
  return api.get<MeditationData>('/api/data/meditation', signal);
}

export interface AddEntryPayload {
  types: string[];
  date: string;
  duration_min: number | null;
  notes: string;
}

export function addMeditationEntry(payload: AddEntryPayload): Promise<{ ok: boolean; id: string }> {
  return api.post<{ ok: boolean; id: string }>('/api/meditation/add', payload);
}

export function removeMeditationEntry(id: string): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/meditation/remove', { id });
}

export interface DeityPayload {
  name: string;
  mantra: string;
  body: string;
  links: DeityLink[];
}

export function addDeityProfile(payload: DeityPayload): Promise<{ ok: boolean; id: string }> {
  return api.post<{ ok: boolean; id: string }>('/api/deity/add', payload);
}

export function updateDeityProfile(id: string, payload: DeityPayload): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/deity/update', { ...payload, id });
}

export function removeDeityProfile(id: string): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/deity/remove', { id });
}
