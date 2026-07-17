/**
 * api.ts — feature-local endpoint helpers over the shared client.
 * Endpoints match routes/travel.py exactly.
 */

import { api } from '../../api/client';
import type { ItemSource, ReturnedState, TemplateItem, TravelData, TripStatus } from './types';

export function getTravelData(signal?: AbortSignal): Promise<TravelData> {
  return api.get('/api/travel/data', signal);
}

// --- trips ---

export interface AddTripPayload {
  name: string;
  destination?: string;
  start?: string;
  end?: string;
  notes?: string;
  template_ids?: string[];
}

export function addTrip(payload: AddTripPayload): Promise<{ ok: boolean; id: string }> {
  return api.post('/api/travel/trip/add', payload);
}

export interface UpdateTripPayload {
  id: string;
  name?: string;
  destination?: string;
  start?: string;
  end?: string;
  status?: TripStatus;
  notes?: string;
}

export function updateTrip(payload: UpdateTripPayload): Promise<{ ok: boolean }> {
  return api.post('/api/travel/trip/update', payload);
}

export function removeTrip(id: string): Promise<{ ok: boolean }> {
  return api.post('/api/travel/trip/remove', { id });
}

// --- packing list items ---

export interface AddItemPayload {
  trip_id: string;
  name: string;
  source?: ItemSource;
  ref_id?: string;
  category?: string;
  notes?: string;
}

export function addTripItem(payload: AddItemPayload): Promise<{ ok: boolean; id: string }> {
  return api.post('/api/travel/item/add', payload);
}

export interface UpdateItemPayload {
  trip_id: string;
  item_id: string;
  packed?: boolean;
  returned?: ReturnedState;
  name?: string;
  category?: string;
  notes?: string;
}

export function updateTripItem(payload: UpdateItemPayload): Promise<{ ok: boolean }> {
  return api.post('/api/travel/item/update', payload);
}

export function removeTripItem(trip_id: string, item_id: string): Promise<{ ok: boolean }> {
  return api.post('/api/travel/item/remove', { trip_id, item_id });
}

// --- templates ---

export function saveTemplate(payload: {
  id?: string;
  name: string;
  items: TemplateItem[];
}): Promise<{ ok: boolean; id: string }> {
  return api.post('/api/travel/template/save', payload);
}

export function removeTemplate(id: string): Promise<{ ok: boolean }> {
  return api.post('/api/travel/template/remove', { id });
}

export function applyTemplate(
  trip_id: string,
  template_id: string,
): Promise<{ ok: boolean; added: number }> {
  return api.post('/api/travel/template/apply', { trip_id, template_id });
}

export function templateFromTrip(
  trip_id: string,
  name: string,
): Promise<{ ok: boolean; id: string }> {
  return api.post('/api/travel/template/from-trip', { trip_id, name });
}
