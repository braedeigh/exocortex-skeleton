import { useCallback, useEffect, useRef, useState } from 'react';
import { loadQueued, migrateNewQueue, saveQueued, type QueuedMessage } from './queuedMessages';
import { release, takeOver, useQueueOwnership } from './queueOwner';

/**
 * useMessageQueue.ts — the observatory's queued sends: the Claude Code
 * queued-prompt gesture, ported. Messages typed while a turn is still writing
 * wait as removable rows and fire when the turn ends; persisted per
 * conversation (queuedMessages.ts) so the TEXT survives a reload.
 *
 * What it does NOT survive is being away. The firing is an effect in this
 * mounted component, so a queued message only sends while the page is open on
 * that conversation — close the PWA and the words are still there when you come
 * back, but nothing was sent while you were gone. Making that true would mean a
 * server-side drain (enqueue through the run queue, let the dispatcher fire it),
 * which is a real change in character, not a bug fix: sessions would talk with
 * nobody watching.
 *
 * ONLY ONE VIEW SENDS. The same conversation can be mounted more than once —
 * two panels, or a tab bar that opens a running session while it's already
 * open. Every mounted view loads the same queue and runs this same effect, so
 * without a claim they would all fire the head message and the model would
 * receive it two or three times. queueOwner.ts hands the right to fire to
 * exactly one of them; the others still hold and display the queue, and take
 * over if the owner closes.
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

  // Same key shape queuedMessages.ts stores under, so "which queue" means the
  // same thing to the claim and to the storage it guards.
  const key = `${botId}:${convId ?? 'new'}`;
  // Identity for THIS mounted view. A ref so it survives re-renders — a fresh
  // symbol each render would look like a different view every time and the
  // claim would never settle.
  const tokenRef = useRef<symbol>(undefined as unknown as symbol);
  if (tokenRef.current === undefined) tokenRef.current = Symbol('queue-view');
  const owns = useQueueOwnership(key, tokenRef.current);
  // Let the next view take over when this one closes, or when it moves to a
  // different conversation.
  useEffect(() => {
    const token = tokenRef.current;
    return () => release(key, token);
  }, [key]);

  // Messages sent while a turn is still writing — the Claude Code queued-
  // prompt gesture: they wait as removable rows and fire when the turn ends.
  // Persisted per conversation (queuedMessages.ts), so a restored queue fires
  // once the conversation is known idle AND this component is mounted on it.
  // Reopening the app is what resumes them; being away does not.
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
    // Only the view that may SEND may also write. A second view holds a copy
    // of the queue from when it loaded; once the owner fires the head, that
    // copy is stale, and letting it write would put the sent message back.
    if (!owns) return;
    saveQueued(botId, convId, queued);
  }, [owns, botId, convId, queued]);

  // Gaining the claim (the owner closed, or she typed in here) means this
  // view's copy may be behind what was actually sent — take storage's word
  // for it rather than its own.
  const ownedRef = useRef(owns);
  useEffect(() => {
    const gained = owns && !ownedRef.current;
    ownedRef.current = owns;
    if (gained) setQueued(loadQueued(botId, convId));
  }, [owns, botId, convId]);

  // Fire the next queued message once the current turn fully ends — or, for
  // a queue restored from storage, once the history load confirms nothing is
  // running. A hard send error pauses the queue (her text is back in the
  // composer; auto-firing more into a broken pipe would just eat them too).
  // `canFire` folds histLoaded/writing/pacing/sendError together (the page
  // computes it — see ObservatoryPage.tsx); pacing matters because the word
  // flow keeps printing briefly after the turn ends — let the tail finish
  // before the next queued turn takes over.
  useEffect(() => {
    // `owns` is the second belt: without it every mounted view of this
    // conversation fires the same head message (see the header).
    if (!owns || !canFire || queued.length === 0) return;
    const [head, ...rest] = queued;
    setQueued(rest);
    onFire(head.text, head.offRecord);
  }, [owns, canFire, queued, onFire]);

  const enqueue = useCallback(
    (text: string, offRecord: boolean) => {
      // Typing here makes this the view that sends. Otherwise a message queued
      // in a second view would be held by a view that isn't allowed to fire it
      // and would simply never go out.
      takeOver(key, tokenRef.current);
      setQueued((q) => [...q, { text, offRecord }]);
    },
    [key],
  );

  const removeAt = useCallback((i: number) => {
    setQueued((prev) => prev.filter((_, j) => j !== i));
  }, []);

  return { queued, enqueue, removeAt };
}
