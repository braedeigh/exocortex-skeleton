/**
 * queuedMessages.ts — persistence for the observatory's queued sends.
 * A queued message is hers, typed and waiting its turn; the turn it waits on
 * survives the PWA closing (it runs detached server-side), so the queue has
 * to survive too. localStorage, one key per conversation.
 *
 * A conversation that doesn't know its id yet (very first turn of a blank
 * compose, still writing) stages under a per-bot `new-` key; once the id
 * arrives the staged messages migrate to the conversation's own key.
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

/** A fresh conversation just learned its id — messages staged under the
 * bot's `new-` key belong to it now (appended after anything already
 * queued there, oldest intent first). */
export function migrateNewQueue(botId: string, convId: string): void {
  const staged = loadQueued(botId);
  if (staged.length === 0) return;
  saveQueued(botId, convId, [...loadQueued(botId, convId), ...staged]);
  saveQueued(botId, undefined, []);
}
