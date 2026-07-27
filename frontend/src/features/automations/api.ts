/**
 * api.ts — typed calls for the automations registry (routes/automations.py).
 * Mirrors the observatory's api.ts: thin wrappers over the shared api
 * client, same-origin, credentials included.
 */
import { api } from '../../api/client';

export interface ScheduledRun {
  id: string;
  name: string;
  description: string;
  schedule: string;
  schedule_human: string;
  enabled: boolean;
  last_run: string | null;
  last_status: 'ok' | 'error' | null;
  last_conv_id: string | null;
  last_cost_usd: number | null;
}

export function getAutomations(signal?: AbortSignal): Promise<{ runs: ScheduledRun[] }> {
  return api.get('/api/automations', signal);
}

export function toggleAutomation(id: string): Promise<{ ok: true; id: string; enabled: boolean }> {
  return api.post(`/api/automations/${encodeURIComponent(id)}/toggle`);
}
