/**
 * api.ts — endpoints for the branches page. Matches routes/branches.py exactly.
 */

import { api } from '../../api/client';
import type { BranchesResponse, ReportResponse } from './types';

export function getBranches(signal?: AbortSignal): Promise<BranchesResponse> {
  return api.get<BranchesResponse>('/api/branches', signal);
}

/** The session's own prose, fetched per branch — deliberately NOT part of the
 * list, so the numbers and the claims never arrive as one blob. */
export function getReport(branch: string, signal?: AbortSignal): Promise<ReportResponse> {
  return api.get<ReportResponse>(`/api/branches/report?branch=${encodeURIComponent(branch)}`, signal);
}
