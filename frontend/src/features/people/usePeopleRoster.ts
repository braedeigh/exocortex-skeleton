import { useQuery } from '@tanstack/react-query';
import { getPeopleRoster } from './api';

export const PEOPLE_ROSTER_QUERY_KEY = ['people', 'roster'] as const;

/**
 * The roster feed. The old people.js fetched /api/people/roster exactly once
 * per dashboard load (`_peopleFetched`) and re-rendered from that cache on
 * every tab switch / sort / filter click — no polling. Mirror that here:
 * treat the data as fresh for the whole SPA session, so route remounts and
 * window refocus don't refetch. (TanStack's gcTime still drops the cache a
 * few minutes after the page unmounts, so a much later revisit refetches —
 * strictly fresher than the old behavior, never staler.)
 */
export function usePeopleRoster() {
  return useQuery({
    queryKey: PEOPLE_ROSTER_QUERY_KEY,
    queryFn: ({ signal }) => getPeopleRoster(signal),
    staleTime: Infinity,
  });
}
