import { useState } from 'react';
import { IconButton } from '../../ui';
import { fmtAddedDate } from './todoHelpers';
import type { TodoItem } from './types';
import styles from './SnoozedCard.module.css';

export interface SnoozedCardProps {
  items: TodoItem[];
  /** Unfiltered snoozed count — header reads "shown/total" when a focus
   * filter is hiding some. */
  totalCount?: number;
  onUnsnooze: (id: string) => void;
}

export function SnoozedCard({ items, totalCount, onUnsnooze }: SnoozedCardProps) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const countText =
    totalCount != null && totalCount !== items.length
      ? `${items.length}/${totalCount}`
      : `${items.length}`;

  return (
    <div className={styles.card}>
      <button type="button" className={styles.summary} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.arrow} ${open ? styles.open : ''}`} aria-hidden="true">
          &#9654;
        </span>
        <span className={styles.title}>Snoozed</span>
        <span className={styles.count}>{countText}</span>
      </button>
      {open
        ? items.map((it) => (
            <div className={styles.row} key={it.id}>
              <span className={styles.text}>
                {it.text}
                <span className={styles.wake}>&#128164; back {fmtAddedDate(it.snoozed_until)}</span>
              </span>
              <IconButton
                className={styles.unsnooze}
                aria-label={`Un-snooze ${it.text}`}
                title="Un-snooze now"
                onClick={() => onUnsnooze(it.id)}
                data-track="todo-unsnooze"
              >
                &#8617;
              </IconButton>
            </div>
          ))
        : null}
    </div>
  );
}
