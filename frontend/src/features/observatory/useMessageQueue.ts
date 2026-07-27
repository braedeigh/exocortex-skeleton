import { useCallback, useEffect, useRef, useState } from 'react';
import { loadQueued, migrateNewQueue, saveQueued, type QueuedMessage } from './queuedMessages';

/**
 * useMessageQueue.ts — the observatory's queued sends: the Claude Code
 * queued-prompt gesture, ported. Messages typed while a turn is still
 * writing wait as removable rows and fire when the turn ends; persisted per
 * conversation (queuedMessages.ts) so closing the PWA loses nothing.
 */
export function useMessageQueue(args: {
  botId: string;
  convId: string | undefined;
  canFire: boolean;
  onFire: (text: string, offRecord: boolean) => void;
}): {
  queued: QueuedMessage[];
  enqueue: (text: string, offRecord: boolean) => void;
  removeAt: (i: number) => void;
} {
  const { botId, convId, canFire, onFire } = args;

  // Messages sent while a turn is still writing — the Claude Code queued-
  // prompt gesture: they wait as removable rows and fire when the turn ends.
  // Persisted per conversation (queuedMessages.ts) so closing the PWA loses
  // nothing; restored queues fire once the conversation is known idle.
  const [queued, setQueued] = useState<QueuedMessage[]>(() => loadQueued(botId, convId));

  // The queue's persistence (queuedMessages.ts): restore when the
  // conversation changes, persist on every change. A blank compose stages
  // under the bot's `new-` key until its conversation id exists.
  const queueConvRef = useRef(convId);
  useEffect(() => {
    const prev = queueConvRef.current;
    queueConvRef.current = convId;
    if (prev === convId) return; // mount — the useState initializer loaded
    // A fresh conversation just got its id (the post-first-turn navigate):
    // whatever was staged under `new-` belongs to it now.
    if (prev === undefined && convId) migrateNewQueue(botId, convId);
    setQueued(loadQueued(botId, convId));
  }, [botId, convId]);
  const persistConvRef = useRef(convId);
  useEffect(() => {
    // The first run after a conversation switch is the restore itself —
    // writing the outgoing queue under the incoming key would carry
    // messages between conversations.
    if (persistConvRef.current !== convId) {
      persistConvRef.current = convId;
      return;
    }
    saveQueued(botId, convId, queued);
  }, [botId, convId, queued]);

  // Fire the next queued message once the current turn fully ends — or, for
  // a queue restored from storage, once the history load confirms nothing is
  // running. A hard send error pauses the queue (her text is back in the
  // composer; auto-firing more into a broken pipe would just eat them too).
  // `canFire` folds histLoaded/writing/pacing/sendError together (the page
  // computes it — see ObservatoryPage.tsx); pacing matters because the word
  // flow keeps printing briefly after the turn ends — let the tail finish
  // before the next queued turn takes over.
  useEffect(() => {
    if (!canFire || queued.length === 0) return;
    const [head, ...rest] = queued;
    setQueued(rest);
    onFire(head.text, head.offRecord);
  }, [canFire, queued, onFire]);

  const enqueue = useCallback((text: string, offRecord: boolean) => {
    setQueued((q) => [...q, { text, offRecord }]);
  }, []);

  const removeAt = useCallback((i: number) => {
    setQueued((prev) => prev.filter((_, j) => j !== i));
  }, []);

  return { queued, enqueue, removeAt };
}
