import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { DEFAULT_SETS, isTabSetList, type TabSet } from './tabSets';

/**
 * useTabSets.ts — loading and saving the pinned-tab sets.
 *
 * Kept in the vault (routes/tabsets.py) rather than the browser so both windows
 * and the phone see the same sets, and clearing browser data doesn't wipe them.
 *
 * WHY IT NEVER RETURNS NOTHING. Every panel's tab bar renders from this, so a
 * moment with no sets is a moment with no tabs — on every panel at once, on
 * every page load. So it starts from the same defaults the server seeds and
 * swaps in the real answer when it arrives, and it falls back to those defaults
 * if the server is unreachable or sends something malformed. The bar is never
 * empty and never flickers.
 *
 * Saves are OPTIMISTIC and the cache is the source of truth while one is in
 * flight: pinning is a click on a star, and a tab that appears a beat later —
 * or worse, appears, vanishes, and reappears — reads as a bug. A failed save
 * rolls the cache back, so the bar always shows something that was really
 * saved or is really about to be.
 *
 * Touches: tabSets.ts (the operations), TabBar.tsx (the only caller),
 * routes/tabsets.py (the other end).
 */

const KEY = ['tab-sets'] as const;

export function useTabSets(): {
  sets: TabSet[];
  save: (next: TabSet[]) => void;
} {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async ({ signal }) => {
      const res = await api.get<{ sets: unknown }>('/api/tabsets', signal);
      return isTabSetList(res.sets) ? res.sets : DEFAULT_SETS;
    },
    // These change a handful of times ever; re-asking on every mount would be
    // a request per panel per page load for an answer that never moved.
    staleTime: 5 * 60_000,
    // Never leave the bar without something to draw.
    placeholderData: DEFAULT_SETS,
  });

  const mutation = useMutation({
    mutationFn: (next: TabSet[]) => api.put<{ sets: TabSet[] }>('/api/tabsets', { sets: next }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: KEY });
      const previous = qc.getQueryData<TabSet[]>(KEY);
      qc.setQueryData(KEY, next);
      return { previous };
    },
    onError: (_err, _next, context) => {
      // Put the bar back to what was actually saved.
      if (context?.previous) qc.setQueryData(KEY, context.previous);
    },
    onSuccess: (res) => {
      // The server cleans what it stores (dedupes, drops malformed sets), so
      // take its answer rather than assuming ours survived intact.
      if (isTabSetList(res.sets)) qc.setQueryData(KEY, res.sets);
    },
  });

  const { mutate } = mutation;
  const save = useCallback((next: TabSet[]) => mutate(next), [mutate]);

  return { sets: data ?? DEFAULT_SETS, save };
}
