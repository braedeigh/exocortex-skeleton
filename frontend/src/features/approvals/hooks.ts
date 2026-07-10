/**
 * hooks.ts — data plumbing for the approvals feature: the 3s /api/pending
 * poll (paused while the tab is hidden) and the dashboard snapshot the
 * food/symptoms editors read for their undo baselines.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getPendingQueue, getTodayData } from './api';

export const PENDING_QUERY_KEY = ['pending'] as const;

/** MUST stay identical to features/todos/useTodayData.TODAY_QUERY_KEY so the
 * snapshot shares that page's cache instead of double-fetching. (Kept as a
 * literal here so the shell-root bundle doesn't pull in the todos feature.) */
export const TODAY_QUERY_KEY = ['data', 'today'] as const;

/** True while the document is visible — flips on visibilitychange. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * The approval queue, polled every 3s (legacy setInterval(checkPendingChanges,
 * 3000)). Fully paused while the tab is hidden: `enabled` gates both the
 * interval and mount/invalidations, and picks straight back up on return.
 */
export function usePendingQueue() {
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: PENDING_QUERY_KEY,
    queryFn: ({ signal }) => getPendingQueue(signal),
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    enabled: visible,
    staleTime: 0,
  });
}

/**
 * The /api/data/today blob — the React stand-in for the legacy `window.D`.
 * The food/symptoms editors read `health_data` from it BEFORE committing so
 * their undo re-POSTs the true previous values.
 */
export function useTodaySnapshot() {
  return useQuery({
    queryKey: TODAY_QUERY_KEY,
    queryFn: ({ signal }) => getTodayData(signal),
    staleTime: 30_000,
  });
}
