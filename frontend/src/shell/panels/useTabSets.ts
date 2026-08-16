import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { DEFAULT_SETS, isTabSetList, removedBuiltIns, type TabSet } from './tabSets';

/**
 * useTabSets.ts — loading and saving the pinned-tab sets.
 *
 * Kept in the vault (routes/tabsets.py) rather than the browser so every window
 * sees the same sets, and clearing browser data doesn't wipe them.
 *
 * EVERY SAVE SAYS WHAT'S DELETED. The server seeds back any built-in set it
 * hasn't been told is gone, so a save that only sent the surviving sets would
 * un-delete the others on the next page load. `removedBuiltIns` reads that
 * straight off the list being saved — no second copy to keep in step.
 *
 * WHERE IT'S STILL THIN: two windows both hold their own copy, and the one
 * that saves last wins the whole list. Refetching when a window is focused
 * shrinks that to the moment before she touches it, rather than however long
 * the window sat there — but a set deleted in one window and a tab pinned in
 * another, fast enough, still resolves to whichever landed second. Closing it
 * properly needs the save to carry the version it was based on, and the server
 * to refuse one built on a stale read. Not built.
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

  const { data, isSuccess } = useQuery({
    queryKey: KEY,
    queryFn: async ({ signal }) => {
      const res = await api.get<{ sets: unknown }>('/api/tabsets', signal);
      return isTabSetList(res.sets) ? res.sets : DEFAULT_SETS;
    },
    // These change a handful of times ever; re-asking on every mount would be
    // a request per panel per page load for an answer that never moved.
    staleTime: 5 * 60_000,
    // ...but DO re-ask when she comes back to a window. That's the moment a
    // second window's copy is most likely to be out of date and about to be
    // written back over a change she made in the first one.
    refetchOnWindowFocus: true,
    // Never leave the bar without something to draw.
    placeholderData: DEFAULT_SETS,
  });

  /* WHETHER WE'RE ENTITLED TO AN OPINION ON WHAT'S DELETED. `removedBuiltIns`
     reads deletion off the list we're holding — sound only when that list came
     from the server. Before the first answer arrives, or if it never does, what
     we're holding is the DEFAULTS, in which nothing is deleted by definition;
     saving from there would tell the server to undelete everything. So until a
     load has actually succeeded we send no `removed` key at all, which the
     route reads as "no opinion" and leaves the stored one alone. */
  const mutation = useMutation({
    mutationFn: (next: TabSet[]) =>
      api.put<{ sets: TabSet[] }>('/api/tabsets', {
        sets: next,
        ...(isSuccess ? { removed: removedBuiltIns(next) } : {}),
      }),
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
