/**
 * sudoApi.ts — the typed door to /api/sudo (routes/sudo.py).
 *
 * What this is, in plain English: agents that need a root command run (most
 * often reloading the web server) file a request instead of asking for the
 * password; this polls the open ones and sends her approve-with-password or
 * decline. One shared query, so the roster's orange box and the bottom popup
 * never ask twice.
 *
 * Touches: routes/sudo.py, SudoPrompt.tsx, SudoHost.tsx, the Observatory roster.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../../api/client';

export interface SudoAsker {
  conv: string;
  title: string;
  reason: string;
  at: string;
}

export interface SudoRequest {
  id: string;
  action: string;
  /** Plain-English name of the action — "Reload the web server". */
  label: string;
  /** The exact command line sudo runs, e.g. "sudo systemctl reload exocortex.service". */
  command: string | null;
  status: 'open' | 'running' | 'done' | 'failed' | 'denied';
  created: string;
  closed_at: string | null;
  result: { exit: number; output: string } | null;
  askers: SudoAsker[];
}

export interface SudoListing {
  open: SudoRequest[];
  recent: SudoRequest[];
}

export type ApproveStatus = 'done' | 'failed' | 'wrong_password' | 'needs_password';

export interface ApproveResult {
  status: ApproveStatus;
  exit: number;
  output: string;
}

export const SUDO_QUERY_KEY = ['sudo-requests'] as const;

/** Poll the queue every few seconds; paused while the tab is hidden. */
export function useSudoRequests() {
  return useQuery({
    queryKey: SUDO_QUERY_KEY,
    queryFn: ({ signal }) => api.get<SudoListing>('/api/sudo/requests', signal),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/** Approve and decline, each refreshing the shared queue when it answers. */
export function useSudoActions() {
  const client = useQueryClient();
  const refresh = useCallback(() => void client.invalidateQueries({ queryKey: SUDO_QUERY_KEY }), [client]);
  const approve = useCallback(
    async (id: string, password: string) => {
      try {
        return await api.post<ApproveResult>(`/api/sudo/requests/${id}/approve`, { password });
      } finally {
        refresh();
      }
    },
    [refresh],
  );
  const deny = useCallback(
    async (id: string) => {
      try {
        await api.post(`/api/sudo/requests/${id}/deny`);
      } finally {
        refresh();
      }
    },
    [refresh],
  );
  return { approve, deny };
}
