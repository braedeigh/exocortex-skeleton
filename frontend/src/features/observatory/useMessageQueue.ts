import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelInboxMessage, fetchInbox, sendToInbox } from './api';
import { loadQueued, saveQueued, type QueuedMessage } from './queuedMessages';

/**
 * useMessageQueue.ts — what she types while a turn is still writing.
 *
 * What this does, in plain English: a message sent while the agent is busy
 * goes to the session's MAILBOX on the server (peermail.py), not a list in the
 * browser. The server hands it to the agent at its next step — the agent reads
 * it mid-turn, the way the Claude Code terminal does — or, if the turn ends
 * first, starts the next turn with it, together with anything other agents
 * sent. Because the server holds it, it goes out whether or not this page is
 * still open. Until it goes, it shows as a removable "queued" row; the rows
 * come from the server, re-read every couple of seconds while any are waiting.
 *
 * One edge stays in the browser: the very first turn of a brand-new compose,
 * before the conversation has an id to address. Those wait here and move to
 * the server the moment the id arrives. A queue left in localStorage by the
 * old browser-side version moves over the same way.
 *
 * Touches: api.ts (sendToInbox / fetchInbox / cancelInboxMessage),
 * queuedMessages.ts (the localStorage staging), ObservatoryPage.tsx (the
 * rows above the composer).
 *
 * Prompt that produced it: "change them to queue messages to the server so
 * they can inject whenever it's ready."
 */

/** A queued row as the page draws it; `id` is set once the server has it. */
export interface QueuedRow extends QueuedMessage {
  id?: number;
}

// How often to re-read the waiting list while something is waiting. A row
// disappears when the agent takes it, so this is how fast she sees it go.
const POLL_MS = 2000;

export function useMessageQueue(args: { botId: string; convId: string | undefined }): {
  queued: QueuedRow[];
  enqueue: (text: string, offRecord: boolean) => void;
  removeAt: (i: number) => void;
} {
  const { botId, convId } = args;
  const [queued, setQueued] = useState<QueuedRow[]>([]);

  // Re-read her waiting messages from the server.
  const refresh = useCallback(async () => {
    if (!convId) return;
    try {
      const { waiting } = await fetchInbox(convId);
      setQueued(waiting.map((w) => ({ id: w.id, text: w.text, offRecord: !w.record })));
    } catch {
      // A missed read just leaves the rows as they were until the next one.
    }
  }, [convId]);

  // Move anything staged in the browser to the server once there's a
  // conversation to address it to: the first-turn edge above, and a queue
  // the old version left in localStorage.
  const staged = useRef<QueuedMessage[]>([]);
  useEffect(() => {
    if (!convId) return;
    const pending = [...staged.current, ...loadQueued(botId), ...loadQueued(botId, convId)];
    staged.current = [];
    saveQueued(botId, undefined, []);
    saveQueued(botId, convId, []);
    void (async () => {
      for (const m of pending) {
        // One that fails stays on screen as a row without an id; she can
        // remove it and send again.
        await sendToInbox(convId, m.text, !m.offRecord).catch(() => undefined);
      }
      await refresh();
    })();
  }, [botId, convId, refresh]);

  // Keep the rows current while any are waiting.
  const waitingCount = queued.length;
  useEffect(() => {
    if (!convId || waitingCount === 0) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [convId, waitingCount, refresh]);

  const enqueue = useCallback(
    (text: string, offRecord: boolean) => {
      // Show it straight away; the server's list replaces this on the next read.
      setQueued((q) => [...q, { text, offRecord }]);
      if (!convId) {
        staged.current.push({ text, offRecord });
        saveQueued(botId, undefined, staged.current);
        return;
      }
      // A failed send leaves the row on screen without an id — visible,
      // removable, never silently dropped.
      sendToInbox(convId, text, !offRecord).then(
        () => void refresh(),
        () => undefined,
      );
    },
    [botId, convId, refresh],
  );

  const removeAt = useCallback(
    (i: number) => {
      const row = queued[i];
      setQueued((prev) => prev.filter((_, j) => j !== i));
      // Already handed to the agent → the server says 409 and the next read
      // settles it; nothing to undo here.
      if (row?.id !== undefined && convId) void cancelInboxMessage(convId, row.id).catch(() => refresh());
    },
    [queued, convId, refresh],
  );

  return { queued, enqueue, removeAt };
}
