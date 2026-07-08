/**
 * endpoints.ts — typed functions for what the app shell needs right now.
 * Payload types live in `./types` (vendored, formerly ts-rs output from
 * exo-core — see the header comment on each file there).
 */
import { api } from './client';

/** GET /api/data/:tab — raw tab payload, shape TBD per-tab until exo-core ships types. */
export function getData(tab: string, signal?: AbortSignal): Promise<unknown> {
  return api.get(`/api/data/${tab}`, signal);
}

export interface VersionInfo {
  version: string;
  [key: string]: unknown;
}

/** GET /api/version */
export function getVersion(signal?: AbortSignal): Promise<VersionInfo> {
  return api.get('/api/version', signal);
}
