/**
 * QueuedRows.tsx — her messages waiting for the agent, drawn above the composer.
 *
 * Each row is one message she sent while a turn was running. It says what
 * state it's in ("queued", "handed in", "not sent"), WHY it's still waiting —
 * the step the agent is in and how long that step has run, since a message is
 * only read when the step ends — and offers two ways out: × takes it back
 * (only while it hasn't been handed in yet), and "send now" stops the step and
 * starts a new turn with it. Send now throws away that step's work, so it asks
 * first, in place, saying so.
 *
 * Touches: useMessageQueue.ts (the rows, the status, remove / sendNow),
 * queuedMessages.ts (waitReason — the words), ObservatoryPage.module.css (the
 * .queued* styles), ObservatoryPage.tsx (where it sits).
 *
 * Prompt that produced it: "show why it's waiting, a send now button, and when
 * each one landed."
 */
import { useState } from 'react';
import type { InboxStatus } from './api';
import { waitReason, type QueuedRow } from './queuedMessages';
import styles from './ObservatoryPage.module.css';

const TAG: Record<QueuedRow['state'], string> = {
  staged: 'queued',
  sending: 'queued',
  waiting: 'queued',
  handed: 'handed in',
  failed: 'not sent',
};

export function QueuedRows({
  rows,
  status,
  onRemove,
  onSendNow,
}: {
  rows: QueuedRow[];
  status: InboxStatus | null;
  onRemove: (row: QueuedRow) => void;
  onSendNow: (row: QueuedRow) => void;
}) {
  // Which row is asking "stop the step and send this now?" — one at a time.
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      {rows.map((q) => {
        const reason = waitReason(q, status);
        // Send now needs a message the server holds and a turn to stop.
        const canRush =
          q.id !== undefined && (q.state === 'waiting' || q.state === 'handed') && !q.rushed && status?.running === true;
        return (
          <div key={q.key} className={styles.queuedRow}>
            <span
              className={[styles.queuedTag, q.state === 'failed' ? styles.queuedTagFailed : ''].filter(Boolean).join(' ')}
            >
              {TAG[q.state]}
            </span>
            <div className={styles.queuedBody}>
              <span className={styles.queuedText}>{q.text}</span>
              {reason ? (
                <span className={styles.queuedWhy}>
                  {reason.text}
                  {reason.detail ? <code className={styles.queuedWhyDetail}>{reason.detail}</code> : null}
                </span>
              ) : null}
              {confirming === q.key && canRush ? (
                <div className={styles.queuedConfirm}>
                  <span className={styles.queuedConfirmText}>
                    Stop the step the agent is on and send this now? Whatever that step was in the middle of is lost.
                  </span>
                  <button
                    type="button"
                    className={styles.queuedConfirmGo}
                    onClick={() => {
                      setConfirming(null);
                      onSendNow(q);
                    }}
                  >
                    Stop &amp; send
                  </button>
                  <button type="button" className={styles.queuedConfirmCancel} onClick={() => setConfirming(null)}>
                    Keep waiting
                  </button>
                </div>
              ) : null}
            </div>
            {canRush && confirming !== q.key ? (
              <button
                type="button"
                className={styles.queuedNow}
                title="Stop the current step and send this now"
                onClick={() => setConfirming(q.key)}
              >
                send now
              </button>
            ) : null}
            {/* Handed in = already inside the running agent: nothing to take back. */}
            {q.state !== 'handed' ? (
              <button
                type="button"
                className={styles.queuedX}
                aria-label="Remove queued message"
                onClick={() => onRemove(q)}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
