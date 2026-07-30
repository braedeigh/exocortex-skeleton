/**
 * useFrontSessions.ts — the conversations filed to one front
 * (/api/fronts/<front>/sessions, routes/fronts.py) plus the "start one here"
 * mutation.
 *
 * A session reaches a front two ways and the panel shows which: EXPLICIT means
 * she started it standing in this room, INFERRED means scripts/sort_bot_chats.py
 * guessed it from the transcript afterwards. Explicit wins server-side; the
 * distinction surfaces here so a guess never passes itself off as a filing.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';

export interface FrontSession {
  id: string;
  title: string;
  /** 'explicit' = filed from this room · 'inferred' = the sorter's guess. */
  source: 'explicit' | 'inferred' | '';
  last_at: string;
  started: string;
  lane: string;
  running: boolean;
  /** One-line "where you left off", from the sorter's gist. May be empty. */
  gist: string;
}

export function frontSessionsKey(frontId: string) {
  return ['fronts', 'sessions', frontId] as const;
}

export function useFrontSessions(frontId: string) {
  return useQuery({
    queryKey: frontSessionsKey(frontId),
    queryFn: ({ signal }) =>
      api.get<{ front: string; sessions: FrontSession[] }>(
        `/api/fronts/${encodeURIComponent(frontId)}/sessions`,
        signal,
      ),
    refetchInterval: 10000,
  });
}

interface CreateResult {
  ok: boolean;
  id: string;
  front: string | null;
  seeded: boolean;
}

/**
 * Start a session in this room. The front is stamped on the index entry (the
 * tag) and, unless seeding is off, the room writes its brief — the front's
 * open to-dos, buy list and threads — for the session to open with (the seed).
 */
export function useStartFrontSession(frontId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { title?: string; seed?: boolean }) =>
      api.post<CreateResult>('/api/observatory/conversations', {
        title: vars.title || '',
        front: frontId,
        ...(vars.seed === false ? { seed: false } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: frontSessionsKey(frontId) });
    },
  });
}

/** The brief a new session here would open with — so the seeded context is
 * inspectable rather than invisible. */
export function useFrontBrief(frontId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['fronts', 'brief', frontId],
    queryFn: ({ signal }) =>
      api.get<{ front: string; brief: string }>(
        `/api/fronts/${encodeURIComponent(frontId)}/brief`,
        signal,
      ),
    enabled,
  });
}
