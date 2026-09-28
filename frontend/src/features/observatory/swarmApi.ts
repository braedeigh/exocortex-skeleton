/**
 * swarmApi.ts — the swarm data the Observatory draws (routes/swarms.py).
 *
 * What this is, in plain English: sessions that have messaged each other form
 * a swarm, and each swarm has a helper that names it and keeps a summary of
 * every member (docs/swarms.md). This file is the typed door to that data,
 * plus one shared poll: every room on the page asks for swarms through
 * useSwarms(), and because they all use the same query key, the page makes
 * ONE request however many rooms are showing.
 *
 * Touches: routes/swarms.py (the endpoints), SwarmCard.tsx and SessionLane.tsx
 * (the cards in each room), RoomMap.tsx (the room from above), SwarmPage.tsx (one swarm's page), and
 * terrain/TerrainPage.tsx (the outlines around swarm members on the map).
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

export type MemberState = 'working' | 'silent' | 'needs_input';

export interface SwarmMember {
  conv: string;
  title: string;
  lane: string;
  state: MemberState;
  /** Archived, or handed its work on to a successor. Absent from an older
   * server, so treat it as optional. */
  retired?: boolean;
  joined_at: string;
  summary: string | null;
  summary_at: string | null;
}

export interface Swarm {
  id: number;
  name: string;
  /** False until the helper has named it — the name is then "Swarm N". */
  named: boolean;
  lane: string;
  helper_conv: string | null;
  summary: string | null;
  summary_at: string | null;
  created_at: string;
  counts: { working: number; silent: number; needs_input: number };
  members: SwarmMember[];
  links: { from: string; to: string; messages: number }[];
  /** Which member took over from which (a continuation). Absent from an
   * older server, so treat it as optional. */
  continues?: { from: string; to: string }[];
}

export interface HelperRun {
  id: number;
  at: string;
  trigger: string | null;
  input: string | null;
  output: {
    name?: string;
    summary?: string;
    members?: { conv: string; summary: string }[];
    differences?: string[];
    messages?: { to: string; text: string }[];
  } | null;
  cost_usd: number | null;
  error: string | null;
}

export interface SwarmDetail extends Swarm {
  runs: HelperRun[];
  messages: { id: number; at: string; from: string; to: string; text: string; mode: string; status: string }[];
  differences: string[];
}

/** Every live swarm — one shared, polled query for the whole page. */
export function useSwarms(enabled = true) {
  return useQuery({
    queryKey: ['swarms'] as const,
    // Off for a logged-out visitor on Terrain: swarms are the owner's.
    enabled,
    queryFn: async ({ signal }) => (await api.get<{ swarms: Swarm[] }>('/api/swarms', signal)).swarms,
    staleTime: 4_000,
    refetchInterval: 5_000,
  });
}

/** The room seen from above (routes/swarms.py `room`): its room helper
 * (room_helper.py), the sessions working alone with the helper's summary of
 * each, and the helper's recent moves. */
export interface RoomView {
  room: string;
  helper_conv: string | null;
  solos: { conv: string; title: string; state: MemberState; summary: string | null }[];
  moves: {
    id: number;
    at: string;
    kind: 'form' | 'join' | 'split' | 'release';
    convs: string[];
    from_swarm: number | null;
    to_swarm: number | null;
    reason: string | null;
    undone_at: string | null;
  }[];
}

/** One room's view from above, polled with the swarms. */
export function useRoomView(room: string, enabled = true) {
  return useQuery({
    queryKey: ['swarm-room', room] as const,
    enabled,
    queryFn: async ({ signal }) =>
      api.get<RoomView>(`/api/swarms/room/${encodeURIComponent(room)}`, signal),
    staleTime: 4_000,
    refetchInterval: 10_000,
  });
}

export function useSwarm(id: number) {
  return useQuery({
    queryKey: ['swarm', id] as const,
    queryFn: async ({ signal }) => api.get<SwarmDetail>(`/api/swarms/${id}`, signal),
    refetchInterval: 5_000,
  });
}

export function refreshSwarm(id: number): Promise<{ ok: boolean; started: boolean }> {
  return api.post(`/api/swarms/${id}/refresh`);
}

/** The card's state, by the same rule as a session card: anyone needing her
 * makes it orange, anyone working makes it purple, otherwise it rests grey. */
export function swarmState(s: Pick<Swarm, 'counts'>): MemberState {
  if (s.counts.needs_input > 0) return 'needs_input';
  if (s.counts.working > 0) return 'working';
  return 'silent';
}
