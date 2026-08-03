/**
 * api.ts — typed calls for the background run queue (routes/run_queue.py).
 *
 * Two things the app needs from the queue: how much room is left on the box
 * right now (so it can ask before starting a session that won't fit), and a way
 * to put a session in the queue instead of starting it. The queue itself is
 * drained by scripts/run_dispatcher.py on a cron tick — nothing here starts
 * anything.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Headroom } from './memoryPrompt';

export type { Headroom } from './memoryPrompt';

/** One entry in the queue. Loose on purpose — the surface that renders these
 * doesn't exist yet, and the server owns the shape. */
export interface QueuedRun {
  id: string;
  lane: string;
  kind: string;
  status: string;
  queued_at: string;
  started: string | null;
  finished: string | null;
  conv_id: string | null;
}

export interface RunQueue {
  running: QueuedRun[];
  queued: QueuedRun[];
  finished: QueuedRun[];
  lanes: string[];
  headroom: Headroom;
}

/**
 * How much room is left. Never throws — a failed check must not block a send,
 * so an unreachable endpoint reads as "no opinion" (null) and the send goes
 * ahead exactly as it did before this existed.
 */
export async function fetchHeadroom(signal?: AbortSignal): Promise<Headroom | null> {
  try {
    return await api.get<Headroom>('/api/runqueue/headroom', signal);
  } catch {
    return null;
  }
}

/** The whole queue — running, waiting (in the order they'll actually start),
 * and a recent tail of what finished. */
export function getRunQueue(signal?: AbortSignal): Promise<RunQueue> {
  return api.get<RunQueue>('/api/runqueue', signal);
}

/**
 * Queue a turn instead of starting it. The prompt text rides along and is
 * stored beside the queue; the dispatcher sends it when a slot opens.
 */
export function enqueueConversation(convId: string, text: string): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/runqueue/enqueue', { conv_id: convId, text });
}

/** Megabytes held right now, keyed by conversation id. A session that isn't
 * running simply isn't in the map. */
export type SessionMemory = Record<string, number>;

/**
 * Live per-session memory, shared by every card on the page.
 *
 * One query key means react-query dedupes it: a roster of twelve cards makes
 * ONE request every few seconds, not twelve. The interval is slower than the
 * roster's own poll on purpose — the server already rounds to the nearest
 * 10MB, and a faster refresh would only add twitch, not information.
 */
export function useSessionMemory(live = false) {
  return useQuery({
    queryKey: ['runqueue', 'session-memory'],
    queryFn: async (): Promise<SessionMemory> => {
      const body = await api.get<{ sessions: SessionMemory }>('/api/runqueue/session-memory');
      return body.sessions ?? {};
    },
    // TWO CLOCKS, ONE MOMENT. The roster learns a session started on its own
    // 5.5s poll; this number arrives on a different one, and nothing links
    // them — so a just-started card sat there saying "starting…" with no
    // figure beside it for the best part of ten seconds. While anything is
    // actually running this tightens up to catch the start; idle, it stays
    // slow, because a page of resting cards has nothing to learn.
    refetchInterval: live ? 2500 : 8000,
    // A failed read means "we don't know", which renders as no number —
    // never a stale one sitting on a card claiming to be live.
    retry: false,
    staleTime: live ? 1200 : 4000,
  });
}

/** Conversations sitting in the run queue — admitted nowhere yet, no process,
 * so `useSessionMemory` correctly knows nothing about them. Its own tiny
 * derived set rather than a field on the roster, for the same reason the
 * memory map is its own endpoint: the queue and the session list are different
 * files answering different questions.
 *
 * Only polled while she's looking at a roster; the dispatcher moves runs on
 * its own clock, so this is a "has my turn started yet" question and a few
 * seconds of lag costs nothing. */
export function useQueuedConvIds() {
  return useQuery({
    queryKey: ['runqueue', 'queued-convs'],
    queryFn: async (): Promise<Set<string>> => {
      const body = await api.get<{ queued?: { conv_id?: string | null }[] }>('/api/runqueue');
      return new Set(
        (body.queued ?? []).map((r) => r.conv_id).filter((id): id is string => Boolean(id)),
      );
    },
    refetchInterval: 5000,
    retry: false,
    staleTime: 3000,
  });
}
