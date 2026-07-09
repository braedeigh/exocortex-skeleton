// api.ts — the People tab's one server call, over the shared fetch client.

import { api } from '../../api/client';
import type { PeopleRosterResponse } from './types';

/**
 * GET /api/people/roster — routes/entities.py people_roster(). Deliberately
 * cheap on the server (built from each person's own file, no vault-wide
 * mention scan); all binning/sorting/filtering happens client-side.
 */
export function getPeopleRoster(signal?: AbortSignal): Promise<PeopleRosterResponse> {
  return api.get<PeopleRosterResponse>('/api/people/roster', signal);
}
