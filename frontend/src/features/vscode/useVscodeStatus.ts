/**
 * useVscodeStatus.ts — TanStack Query wiring for /api/vscode/status.
 *
 * Matches the old page's fetch discipline exactly: one check on load, then
 * a 1s poll ONLY while a start is in flight (the idle launcher never
 * polled). No focus refetch, no retries — the old page surfaced a single
 * failed fetch as "status check failed" rather than silently retrying.
 */

import { useQuery } from '@tanstack/react-query';
import { getVscodeStatus } from './api';
import { STATUS_POLL_MS } from './vscodeMath';

export const VSCODE_STATUS_KEY = ['vscode', 'status'] as const;

export function useVscodeStatus(polling: boolean) {
  return useQuery({
    queryKey: VSCODE_STATUS_KEY,
    queryFn: ({ signal }) => getVscodeStatus(signal),
    refetchInterval: polling ? STATUS_POLL_MS : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 0,
  });
}
