import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelInboxMessage, fetchInbox, sendToInbox } from './api';
import {
  loadQueued,
  mergeQueueRows,
  pruneSettled,
  rowsFromServer,
  saveQueued,
  type QueuedRow,
} from './queuedMessages';

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
 * The browser keeps its own copy of a row until the server has spoken for it
 * (queuedMessages.ts mergeQueueRows): while it's on its way, and for good if
 * the server refused it — that one stays on screen marked "not sent", because
 * the composer was already cleared and a message that silently vanished would
 * be lost.
 *
 * One edge stays in the browser: the very first turn of a brand-new compose,
 * before the conversation has an id to address. Those wait here and move to
 * the server the moment the id arrives. A queue left in localStorage by the
 * old browser-side version moves over the same way.
 *
 * Touches: api.ts (sendToInbox / fetchInbox / cancelInboxMessage),
 * queuedMessages.ts (the localStorage staging and the row merge),
 * ObservatoryPage.tsx (the rows above the composer).
 *
 * Prompt that produced it: "change them to queue messages to the server so
 * they can inject whenever it's ready."
 */

export type { QueuedRow } from './queuedMessages';

// How often to re-read the waiting list while something is waiting. A row
// disappears when the agent takes it, so this is how fast she sees it go.
const POLL_MS = 2000;

export function useMessageQueue(args: { botId: string; convId: string | undefined }): {
  queued: QueuedRow[];
  enqueue: (text: string, offRecord: boolean) => void;
  remove: (row: QueuedRow) => void;
} {
  const { botId, convId } = args;
  // The server's waiting list, and the browser's own rows (staged, sending,
  // failed). A ref mirrors the local rows so the callbacks below can read
  // them without re-binding on every change.
  const [serverRows, setServerRows] = useState<QueuedRow[]>([]);
  const [localRows, setLocalRows] = useState<QueuedRow[]>([]);
  const localRef = useRef<QueuedRow[]>([]);
  localRef.current = localRows;
  const nextKey = useRef(0);
  const newKey = () => `l${nextKey.current++}`;
  // Rows she removed while their send was still in flight — if the server
  // takes one anyway, it gets cancelled there as soon as the id comes back.
  const removedWhileSending = useRef(new Set<string>());

  // Re-read her waiting messages from the server, then drop the browser's
  // copy of anything the server confirmed before this read began.
  const refresh = useCallback(async () => {
    if (!convId) return;
    const readStartedAt = Date.now();
    try {
      const { waiting } = await fetchInbox(convId);
      setServerRows(rowsFromServer(waiting));
      setLocalRows((rows) => pruneSettled(rows, readStartedAt));
    } catch {
      // A missed read just leaves the rows as they were until the next one.
    }
  }, [convId]);

  // Hand one row to the server's mailbox and record the answer on the row:
  // its id when the server took it, `failed` when it didn't.
  const post = useCallback(
    async (conv: string, row: QueuedRow) => {
      try {
        const { id } = await sendToInbox(conv, row.text, !row.offRecord);
        if (removedWhileSending.current.delete(row.key)) {
          void cancelInboxMessage(conv, id).catch(() => undefined);
          return;
        }
        setLocalRows((rows) =>
          rows.map((r) => (r.key === row.key ? { ...r, id, confirmedAt: Date.now() } : r)),
        );
        void refresh();
      } catch {
        removedWhileSending.current.delete(row.key);
        setLocalRows((rows) => rows.map((r) => (r.key === row.key ? { ...r, state: 'failed' } : r)));
      }
    },
    [refresh],
  );

  // Move anything staged in the browser to the server once there's a
  // conversation to address it to: the first-turn edge above, and a queue
  // the old version left in localStorage. Sent one at a time so they arrive
  // in the order she wrote them.
  useEffect(() => {
    if (!convId) return;
    const staged = localRef.current.filter((r) => r.state === 'staged');
    const leftovers: QueuedRow[] = [...loadQueued(botId), ...loadQueued(botId, convId)]
      .filter((m) => !staged.some((r) => r.text === m.text))
      .map((m) => ({ ...m, key: newKey(), state: 'sending' }));
    saveQueued(botId, undefined, []);
    saveQueued(botId, convId, []);
    const moving = [...staged.map((r) => ({ ...r, state: 'sending' as const })), ...leftovers];
    setLocalRows((rows) => [
      ...rows.map((r) => (r.state === 'staged' ? { ...r, state: 'sending' as const } : r)),
      ...leftovers,
    ]);
    void (async () => {
      for (const row of moving) await post(convId, row);
      await refresh();
    })();
    // newKey only touches a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, convId, post, refresh]);

  // Keep the rows current while any are waiting on the server or on their
  // way there. A failed row doesn't need the server, so it doesn't poll.
  const liveCount = serverRows.length + localRows.filter((r) => r.state === 'sending').length;
  useEffect(() => {
    if (!convId || liveCount === 0) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [convId, liveCount, refresh]);

  const enqueue = useCallback(
    (text: string, offRecord: boolean) => {
      // Show it straight away as the browser's own row.
      if (!convId) {
        const row: QueuedRow = { key: newKey(), text, offRecord, state: 'staged' };
        setLocalRows((rows) => [...rows, row]);
        const staged = [...localRef.current.filter((r) => r.state === 'staged'), row];
        saveQueued(
          botId,
          undefined,
          staged.map((r) => ({ text: r.text, offRecord: r.offRecord })),
        );
        return;
      }
      const row: QueuedRow = { key: newKey(), text, offRecord, state: 'sending' };
      setLocalRows((rows) => [...rows, row]);
      void post(convId, row);
    },
    // newKey only touches a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [botId, convId, post],
  );

  const remove = useCallback(
    (row: QueuedRow) => {
      setLocalRows((rows) => rows.filter((r) => r.key !== row.key));
      if (row.id !== undefined) {
        // On the server: cancel it there. Already handed to the agent → the
        // server says 409 and the next read settles it.
        setServerRows((rows) => rows.filter((r) => r.id !== row.id));
        if (convId) void cancelInboxMessage(convId, row.id).catch(() => refresh());
        return;
      }
      // Still on its way: cancel it once the server's id comes back.
      if (row.state === 'sending') removedWhileSending.current.add(row.key);
      // Staged: take it out of the localStorage copy too.
      if (row.state === 'staged') {
        const staged = localRef.current.filter((r) => r.state === 'staged' && r.key !== row.key);
        saveQueued(
          botId,
          undefined,
          staged.map((r) => ({ text: r.text, offRecord: r.offRecord })),
        );
      }
    },
    [botId, convId, refresh],
  );

  return { queued: mergeQueueRows(serverRows, localRows), enqueue, remove };
}
