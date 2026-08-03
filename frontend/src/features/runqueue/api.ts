/**
 * api.ts — typed calls for the background run queue (routes/run_queue.py).
 *
 * Two things the app needs from the queue: how much room is left on the box
 * right now (so it can ask before starting a session that won't fit), and a way
 * to put a session in the queue instead of starting it. The queue itself is
 * drained by scripts/run_dispatcher.py on a cron tick — nothing here starts
 * anything.
 */
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
