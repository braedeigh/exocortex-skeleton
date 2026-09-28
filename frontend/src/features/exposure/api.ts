/**
 * api.ts — the exposure endpoints (routes/exposure.py) over the shared client.
 */
import { api } from '../../api/client';
import type { VerdictReview } from '../kitchen/types';
import type {
  Contaminant,
  ContaminantListItem,
  ExposureMethod,
  ExposureScore,
  FoodExposure,
  SampleClaim,
} from './types';

export function getFoodExposure(name: string, signal?: AbortSignal) {
  return api.get<{ food: FoodExposure | null; method: ExposureMethod }>(
    `/api/exposure/food?name=${encodeURIComponent(name)}`,
    signal,
  );
}

export function scoreFood(name: string, years: number[], claim: SampleClaim) {
  return api.post<{ score: ExposureScore }>('/api/exposure/food/score', { name, years, claim });
}

export function getContaminants(signal?: AbortSignal) {
  return api.get<{ contaminants: ContaminantListItem[] }>('/api/exposure/contaminants', signal);
}

export function getContaminant(id: number, signal?: AbortSignal) {
  return api.get<{ contaminant: Contaminant; method: ExposureMethod }>(`/api/exposure/contaminants/${id}`, signal);
}

export function reviewFact(id: number, review: VerdictReview) {
  return api.post<{ ok: boolean }>(`/api/exposure/facts/${id}/review`, { review });
}

export interface SourcePdfInfo {
  pdf: boolean;
  pages?: number | null;
  sha256?: string;
  passages?: Record<string, number>;
}

export function getSourcePdfInfo(sourceId: string, signal?: AbortSignal) {
  return api.get<SourcePdfInfo>(`/api/exposure/sources/${encodeURIComponent(sourceId)}/pdf-info`, signal);
}
