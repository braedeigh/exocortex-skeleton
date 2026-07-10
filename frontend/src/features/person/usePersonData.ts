// usePersonData.ts — TanStack Query bindings for the person page.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { getPerson, savePersonFacts, summarizePerson } from './api';
import type { PersonResponse, SummarizeResponse } from './types';

export function personKey(slug: string) {
  return ['person', slug] as const;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The whole page's data in one call — the old page fetched /api/person/<slug>
 * exactly once per load, so no polling here either.
 */
export function usePerson(slug: string) {
  return useQuery({
    queryKey: personKey(slug),
    queryFn: ({ signal }) => getPerson(slug, signal),
  });
}

/**
 * Replace-the-facts mutation. On success the server's re-serialized facts
 * map is written straight into the page query (it's the new source of truth
 * — key order included), so no refetch of the whole vault scan is needed.
 */
export function useSaveFacts(slug: string, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (facts: Record<string, string>) => savePersonFacts(slug, facts),
    onError: (err) => onError(errorMessage(err, "Couldn't save facts")),
    onSuccess: (data) => {
      queryClient.setQueryData<PersonResponse>(personKey(slug), (cur) =>
        cur ? { ...cur, person: { ...cur.person, facts: data.facts } } : cur,
      );
    },
  });
}

/**
 * "Regenerate impression" — slow by design (the server boots/reuses a tmux
 * Claude session and types the prompt in before responding). The component
 * shows the pending state off `isPending`; success hands back the session
 * name to deep-link into.
 */
export function useSummarize(
  slug: string,
  onSuccess: (data: SummarizeResponse) => void,
  onError: (message: string) => void,
) {
  return useMutation({
    mutationFn: () => summarizePerson(slug),
    onSuccess,
    onError: (err) => onError(errorMessage(err, "Couldn't start the impression session")),
  });
}
