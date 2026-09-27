/**
 * api.ts — typed calls for the Ecosystem tab, over the shared fetch client.
 * Backend: routes/ecosystem.py + server.py get_data_ecosystem().
 *
 * Note the assist endpoints (geocode / USDA) return {ok:false, reason} with an
 * HTTP 200 — "no match" is a normal answer, not an error — so their result
 * types carry the failure shape instead of throwing.
 */
import { api } from '../../api/client';
import type { CountyDetail, EcosystemData } from './types';

/** GET /api/data/ecosystem — sources + light recipes, polled every 5s. */
export function getEcosystemData(signal?: AbortSignal): Promise<EcosystemData> {
  return api.get('/api/data/ecosystem', signal);
}

export interface SourcePayload {
  id?: string;
  name: string;
  note: string;
  lat: number;
  lng: number;
  precision: string;
  radius_km: number;
  transparency: string;
  area_kind: string;
  counties: string[];
  region_name: string;
  geo_source: string;
  origin: string;
  origin_detail: string;
  origin_url: string;
  origin_date: string;
  county_detail: CountyDetail[];
  /** Adding only: link the new source to this food (id or name) or product. */
  food?: number | string | null;
  product_id?: number | null;
}

/** The origin record an assist hands back with its answer (sourcestore.ORIGINS). */
export interface OriginRecord {
  origin?: string;
  origin_detail?: string;
  origin_url?: string;
  origin_date?: string;
}

export function addSource(payload: SourcePayload): Promise<{ ok: boolean; id: string }> {
  return api.post('/api/ecosystem/source/add', payload);
}

export function updateSource(payload: SourcePayload): Promise<{ ok: boolean }> {
  return api.post('/api/ecosystem/source/update', payload);
}

export function removeSource(id: string): Promise<{ ok: boolean }> {
  return api.post('/api/ecosystem/source/remove', { id });
}

/** Say a food (by id or name) or one product comes from this source. */
export function linkSource(
  sourceId: string,
  target: { food?: number | string; product_id?: number },
): Promise<{ ok: boolean; id: number }> {
  return api.post('/api/ecosystem/link', { source_id: sourceId, ...target });
}

export function unlinkSource(linkId: number): Promise<{ ok: boolean }> {
  return api.post('/api/ecosystem/unlink', { link_id: linkId });
}

export interface GeocodeResult extends OriginRecord {
  ok: boolean;
  lat?: number;
  lng?: number;
  label?: string;
  reason?: string;
}

/** Resolve a typed address/place to lat/lng (server-side Nominatim proxy). */
export function geocodeAddress(address: string): Promise<GeocodeResult> {
  return api.post('/api/ecosystem/geocode', { address });
}

export interface UsdaSuggestion extends OriginRecord {
  ok: boolean;
  mode?: 'counties' | 'state';
  commodity?: string;
  /** counties mode: 5-digit FIPS codes. */
  counties?: string[];
  /** counties mode: what USDA reported for each, biggest first. */
  detail?: CountyDetail[];
  /** state mode */
  region_name?: string;
  state?: string;
  lat?: number;
  lng?: number;
  label?: string;
  note?: string;
  need_key?: boolean;
  reason?: string;
}

/** Ask USDA QuickStats where a named food is generally grown. */
export function usdaSuggest(name: string): Promise<UsdaSuggestion> {
  return api.post('/api/ecosystem/usda/suggest', { name });
}

export function saveUsdaKey(key: string): Promise<{ ok: boolean; key_set: boolean }> {
  return api.post('/api/ecosystem/usda/key', { key });
}
