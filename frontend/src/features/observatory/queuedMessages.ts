/**
 * queuedMessages.ts — the browser-side staging for her queued sends.
 * Her queued messages live on the server now (the session's mailbox —
 * useMessageQueue.ts). This is only the holding pen for the one case the
 * server can't take yet: the very first turn of a blank compose, before the
 * conversation has an id. Those stage under a per-bot `new-` key in
 * localStorage and move to the server when the id arrives. It also reads the
 * per-conversation keys the old browser-side queue left behind, so nothing
 * typed under the old version is lost.
 *
 * It also holds the pure rule for which rows the page shows (mergeQueueRows):
 * the server's waiting list, plus the ones the browser still holds — staged,
 * on their way, or refused. That second half is what keeps a message the
 * server never got on screen instead of letting the next read wipe it.
 */

export interface QueuedMessage {
  text: string;
  offRecord: boolean;
}

// 'exo-bot-queue:*' predates the observatory rename (07-24) — the persona
// concept ("bot") stays, so this on-disk/localStorage key prefix is
// deliberately unchanged.
const queueKey = (botId: string, convId?: string) => `exo-bot-queue:${convId ?? `new-${botId}`}`;

export function loadQueued(botId: string, convId?: string): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(queueKey(botId, convId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (q): q is { text: string; offRecord?: unknown } =>
          typeof q === 'object' && q !== null && typeof (q as { text?: unknown }).text === 'string',
      )
      .map((q) => ({ text: q.text, offRecord: q.offRecord === true }));
  } catch {
    return []; // storage disabled or corrupt — the queue just doesn't persist
  }
}

export function saveQueued(
  botId: string,
  convId: string | undefined,
  queued: QueuedMessage[],
): void {
  try {
    const key = queueKey(botId, convId);
    if (queued.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(queued));
  } catch {
    // storage disabled — nothing to do
  }
}

/** Where a queued row stands. `staged`: no conversation id to send it to yet.
 * `sending`: posted, answer not back. `failed`: the server never took it.
 * `waiting`: the server has it and the agent hasn't picked it up. */
export type QueuedState = 'staged' | 'sending' | 'failed' | 'waiting';

/** One queued row as the page draws it. `key` is stable for React; `id` is
 * the server's, once it has one. `confirmedAt` marks when the browser learned
 * the server took it — the next read started after that is the one that can
 * speak for it. */
export interface QueuedRow extends QueuedMessage {
  key: string;
  state: QueuedState;
  id?: number;
  confirmedAt?: number;
}

/** The server's waiting list as rows. */
export function rowsFromServer(waiting: { id: number; text: string; record: boolean }[]): QueuedRow[] {
  return waiting.map((w) => ({ key: `s${w.id}`, id: w.id, text: w.text, offRecord: !w.record, state: 'waiting' }));
}

/** Drop the browser's copy of rows the server has now spoken for: ones it
 * confirmed before this read started. Whether the read listed them (still
 * waiting) or not (the agent took them), the server's list is the truth for
 * them from here. Rows still staged, sending or failed are kept. */
export function pruneSettled(local: QueuedRow[], readStartedAt: number): QueuedRow[] {
  return local.filter((r) => r.confirmedAt === undefined || r.confirmedAt > readStartedAt);
}

/** What the page shows: the server's rows, then the browser's own that the
 * server's list doesn't already carry (matched by id). */
export function mergeQueueRows(server: QueuedRow[], local: QueuedRow[]): QueuedRow[] {
  const onServer = new Set(server.map((r) => r.id));
  return [...server, ...local.filter((r) => r.id === undefined || !onServer.has(r.id))];
}
