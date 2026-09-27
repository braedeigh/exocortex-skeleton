/**
 * queuedMessages.ts — the browser-side staging for her queued sends.
 * Her queued messages live on the server now (the session's mailbox —
 * useMessageQueue.ts). This is only the holding pen for the one case the
 * server can't take yet: the very first turn of a blank compose, before the
 * conversation has an id. Those stage under a per-bot `new-` key in
 * localStorage and move to the server when the id arrives. It also reads the
 * per-conversation keys the old browser-side queue left behind, so nothing
 * typed under the old version is lost.
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
