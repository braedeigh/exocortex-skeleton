/**
 * api.ts — typed poll of GET /api/observatory/flow (routes/terrain.py): the
 * live stream of code being written. Every Edit/Write an agent has made in
 * the recent window, newest first, each carrying the text it wrote. The lane
 * (FlowLane.tsx) is the only reader.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

export interface FlowEvent {
  /** Stable across polls (conversation id + event position in its log) —
   * React keys on it, so an already-shown card never remounts or re-animates
   * when the poll brings it again. */
  id: string;
  conv: string;
  title: string;
  bot: string | null;
  running: boolean;
  repo: string;
  path: string;
  kind: 'edit' | 'write' | 'create';
  ts: string | null;
  /** Unix seconds — the sort key and the age source. */
  epoch: number;
  /** The written text, head-trimmed server-side; null for secret-named files
   * (the event still shows, its contents don't). */
  snippet: string | null;
  /** How many lines the write really was, so the card can say "of 118". */
  snippet_total_lines: number;
}

export interface FlowData {
  generated_at: string;
  lookback_sec: number;
  events: FlowEvent[];
}

export const FLOW_KEY = ['flow'] as const;

/**
 * Polls every ~5s while the page is visible — same live cadence as the
 * terrain map next door, and react-query already pauses interval refetches
 * for a backgrounded tab. `live=false` (page hidden) stops the interval
 * entirely so a lane on a sleeping monitor costs nothing.
 */
export function useFlow(live = true) {
  return useQuery({
    queryKey: FLOW_KEY,
    queryFn: async ({ signal }) => api.get<FlowData>('/api/observatory/flow', signal),
    staleTime: 4_000,
    refetchInterval: live ? 5_000 : false,
    placeholderData: (prev) => prev,
  });
}
