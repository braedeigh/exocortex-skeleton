import { useState } from 'react';
import { IconButton } from '../../ui';
import type { WaitingEntry } from './todoHelpers';
import styles from './WaitingCard.module.css';

export interface WaitingCardProps {
  entries: WaitingEntry[];
  /** Unfiltered waiting count — header reads "shown/total" when a focus
   * filter is hiding some. */
  totalCount?: number;
  onClear: (id: string) => void;
}

/** "Do after" twin of SnoozedCard — a collapsible list of to-dos hidden
 * until a date arrives or a blocker to-do finishes, each with its reason
 * and a clearly visible unblock button. */
export function WaitingCard({ entries, totalCount, onClear }: WaitingCardProps) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const countText =
    totalCount != null && totalCount !== entries.length
      ? `${entries.length}/${totalCount}`
      : `${entries.length}`;

  return (
    <div className={styles.card}>
      <button type="button" className={styles.summary} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.arrow} ${open ? styles.open : ''}`} aria-hidden="true">
          &#9654;
        </span>
        <span className={styles.title}>Waiting</span>
        <span className={styles.count}>{countText}</span>
      </button>
      {open
        ? entries.map(({ item, reason }) => (
            <div className={styles.row} key={item.id}>
              <span className={styles.text}>
                {item.text}
                <span className={styles.reason}>{reason}</span>
              </span>
              <IconButton
                className={styles.unblock}
                aria-label={`Un-block ${item.text}`}
                title="Clear do-after"
                onClick={() => onClear(item.id)}
              >
                &#8617;
              </IconButton>
            </div>
          ))
        : null}
    </div>
  );
}
