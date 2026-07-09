/**
 * api.ts — feature-local endpoint helpers over the shared client.
 * Endpoints verified against static/js/car.js + routes/car.py + server.py:
 *   GET  /api/data/car        (polled every 5s, same as the old dashboard loop)
 *   POST /api/car/add         {type, date, mileage, notes, next_due}
 *   POST /api/car/remove      {id}
 *   POST /api/car/notes/save  {text}
 * (/api/car/update exists server-side but the old UI never called it.)
 */

import { api } from '../../api/client';
import type { CarData } from './types';

/** Field values exactly as the old form posted them — strings, '' for blank. */
export interface AddCarEntryPayload {
  type: string;
  date: string;
  mileage: string;
  notes: string;
  next_due: string;
}

export function getCarData(signal?: AbortSignal): Promise<CarData> {
  return api.get('/api/data/car', signal);
}

export function addCarEntry(payload: AddCarEntryPayload): Promise<{ ok: boolean; id: string }> {
  return api.post('/api/car/add', payload);
}

export function removeCarEntry(id: string): Promise<{ ok: boolean }> {
  return api.post('/api/car/remove', { id });
}

export function saveCarNotes(text: string): Promise<{ ok: boolean }> {
  return api.post('/api/car/notes/save', { text });
}
