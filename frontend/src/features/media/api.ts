/** Media API helpers — same endpoints the old media.js hit, through the
 * shared typed client. */
import { api } from '../../api/client';
import type { MediaData } from './types';

/** Full field set for add / full edit-save (what both old forms POSTed). */
export interface MediaItemFields {
  title: string;
  type: string;
  author: string;
  recommended_by: string;
  /** YYYY-MM-DD; empty string stores as null ("undated") server-side. */
  date: string;
  notes: string;
  done?: boolean;
}

/** /api/media/update only touches fields present in the body. */
export type MediaItemPatch = { id: string } & Partial<MediaItemFields>;

export function getMediaData(signal?: AbortSignal): Promise<MediaData> {
  return api.get<MediaData>('/api/data/media', signal);
}

export function addMediaItem(fields: MediaItemFields): Promise<{ ok: boolean; id: string }> {
  return api.post<{ ok: boolean; id: string }>('/api/media/add', fields);
}

export function updateMediaItem(patch: MediaItemPatch): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/media/update', patch);
}

export function removeMediaItem(id: string): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/media/remove', { id });
}
