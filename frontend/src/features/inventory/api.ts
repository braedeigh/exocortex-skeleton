/**
 * Inventory endpoint helpers — feature-local (the shared src/api/endpoints.ts
 * is owned by other features; strict porting rule keeps ours here). All JSON
 * calls go through the shared client; the two photo-upload calls are
 * multipart, which the JSON-only client can't express, so they use a small
 * postForm() with the same 401/error semantics.
 */
import { api, ApiError } from '../../api/client';
import type { BuyItem, InventoryData } from './types';

export const INVENTORY_QUERY_KEY = ['data', 'inventory'] as const;

export function getInventoryData(signal?: AbortSignal): Promise<InventoryData> {
  return api.get<InventoryData>('/api/data/inventory', signal);
}

// --- Priority notes ---

export function savePriorityNotes(text: string): Promise<unknown> {
  return api.post('/api/priority-notes/save', { text });
}

// --- Buy list (routes/inventory.py) ---

export interface AddBuyPayload {
  name: string;
  priority: string;
  kind: string;
  where: string;
  category: string;
  notes: string;
}

export function addBuyItem(payload: AddBuyPayload): Promise<unknown> {
  return api.post('/api/buy/add', payload);
}

/** Full edit payload from the buy modal / detail page. `name` is the current
 * identity; `new_name` renames (server ignores dupes/empties). */
export interface UpdateBuyPayload extends Partial<BuyItem> {
  name: string;
  new_name?: string;
}

export function updateBuyItem(payload: UpdateBuyPayload): Promise<unknown> {
  return api.post('/api/buy/update', payload);
}

export function removeBuyItem(name: string): Promise<unknown> {
  return api.post('/api/buy/remove', { name });
}

/** "bought" — removes from the buy list, adds/reorders into active inventory. */
export function moveBuyToActive(name: string): Promise<unknown> {
  return api.post('/api/buy/move-to-active', { name });
}

// --- Active inventory (consumables loop) ---

/** Marks running_low and auto-adds a high-priority consumable to the buy list. */
export function restockActive(name: string): Promise<unknown> {
  return api.post('/api/active/restock', { name });
}

export function retireActive(name: string, review: string): Promise<unknown> {
  return api.post('/api/active/retire', { name, review });
}

export function unretireActive(name: string): Promise<unknown> {
  return api.post('/api/active/unretire', { name });
}

export function updateActiveReview(name: string, review: string): Promise<unknown> {
  return api.post('/api/active/update', { name, review });
}

export function removeActiveItem(name: string): Promise<unknown> {
  return api.post('/api/active/remove', { name });
}

// --- Archivals (routes/archivals.py) ---

export interface ArchivalFieldsPayload {
  name: string;
  category: string;
  subcategory: string;
  origin: string;
  /** Freeform "Cotton 80, Polyester 20" — parsed server-side. */
  materials: string;
  description: string;
  secondhand: string;
  gifted: string;
  private: string;
}

export function updateArchival(id: string, fields: ArchivalFieldsPayload): Promise<unknown> {
  return api.post('/api/archivals/update', { id, ...fields });
}

export function removeArchival(id: string): Promise<unknown> {
  return api.post('/api/archivals/remove', { id });
}

export function removeArchivalPhoto(itemId: string, photoId: string): Promise<unknown> {
  return api.post(`/api/archivals/${encodeURIComponent(itemId)}/photos/remove`, {
    photo_id: photoId,
  });
}

export function setMainArchivalPhoto(itemId: string, photoId: string): Promise<unknown> {
  return api.post(`/api/archivals/${encodeURIComponent(itemId)}/photos/main`, {
    photo_id: photoId,
  });
}

/** Multipart POST — mirrors client.ts semantics (same-origin, credentials,
 * 401 -> /login, JSON {error} surfaced as ApiError). No Content-Type header:
 * the browser sets the multipart boundary itself. */
async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'include', body: form });

  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    let message = res.statusText || `Request failed with status ${res.status}`;
    try {
      const data: unknown = await res.clone().json();
      if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
        message = data.error;
      }
    } catch {
      // not JSON — keep statusText
    }
    throw new ApiError(res.status, message);
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** New archival — multipart so up to 5 photos ride along with the fields. */
export function addArchival(fields: ArchivalFieldsPayload, photos: File[]): Promise<unknown> {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  photos.forEach((f) => fd.append('photos', f));
  return postForm('/api/archivals/add', fd);
}

export function addArchivalPhotos(itemId: string, photos: File[]): Promise<unknown> {
  const fd = new FormData();
  photos.forEach((f) => fd.append('photos', f));
  return postForm(`/api/archivals/${encodeURIComponent(itemId)}/photos`, fd);
}
