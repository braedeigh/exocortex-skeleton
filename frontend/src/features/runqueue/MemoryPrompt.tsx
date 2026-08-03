/**
 * MemoryPrompt.tsx — "there isn't room for this right now. What do you want?"
 *
 * Plain English: shows a bar of what's using the box's memory, one sentence
 * about why we stopped, and up to three buttons — start it anyway, put it in
 * the queue so it starts when a slot opens, or back out. All the decisions
 * (whether to show it at all, which buttons, what the bar looks like) live in
 * memoryPrompt.ts so they can be tested without React; this file is the
 * rendering.
 *
 * Talks to: memoryPrompt.ts (the rules), api.ts (enqueueConversation), and the
 * Sheet in ../../ui for the modal shell every other dialog here uses.
 */
import { useState } from 'react';
import { Sheet } from '../../ui';
import { barSegments, promptActions, promptReason, queueSummary } from './memoryPrompt';
import type { Headroom } from './memoryPrompt';
import styles from './MemoryPrompt.module.css';

export function MemoryPrompt({
  open,
  headroom,
  serverRefused = false,
  onStartAnyway,
  onQueue,
  onClose,
}: {
  open: boolean;
  headroom: Headroom | null;
  /** True when we're here because the send already came back 503. */
  serverRefused?: boolean;
  onStartAnyway: () => void;
  onQueue: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [queueing, setQueueing] = useState(false);
  const actions = promptActions(headroom, serverRefused);
  const segments = barSegments(headroom);
  const summary = queueSummary(headroom);

  const queue = async () => {
    setQueueing(true);
    try {
      await onQueue();
    } finally {
      setQueueing(false);
    }
  };

  return (
    <Sheet open={open} title="Not much room left" onClose={onClose}>
      <div className={styles.body}>
        <p className={styles.reason}>{promptReason(headroom, serverRefused)}</p>

        {segments && (
          <>
            <div
              className={styles.bar}
              role="img"
              aria-label={`Memory: ${segments.used}% in use, ${segments.reserved}% kept free for the site, ${segments.free}% available`}
            >
              <div className={styles.used} style={{ width: `${segments.used}%` }} />
              <div className={styles.reserved} style={{ width: `${segments.reserved}%` }} />
              <div className={styles.free} style={{ width: `${segments.free}%` }} />
            </div>
            <div className={styles.legend}>
              <span className={styles.legendItem}>
                <span className={`${styles.swatch} ${styles.used}`} /> In use
              </span>
              <span className={styles.legendItem}>
                <span className={`${styles.swatch} ${styles.reserved}`} /> Kept for the site
              </span>
              <span className={styles.legendItem}>
                <span className={`${styles.swatch} ${styles.free}`} /> Free
              </span>
            </div>
          </>
        )}

        {summary && <div className={styles.summary}>{summary}</div>}

        <div className={styles.actions}>
          {actions.includes('queue') && (
            <button
              type="button"
              className={`${styles.action} ${styles.primary}`}
              onClick={() => void queue()}
              disabled={queueing}
            >
              {queueing ? 'Queueing…' : 'Queue it — start when there’s room'}
            </button>
          )}
          {actions.includes('start') && (
            <button type="button" className={styles.action} onClick={onStartAnyway}>
              Start anyway
            </button>
          )}
          <button type="button" className={styles.action} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  );
}
