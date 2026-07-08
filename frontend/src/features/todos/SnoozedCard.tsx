import { useState } from 'react';
import { IconButton } from '../../ui';
import { fmtAddedDate } from './todoHelpers';
import type { TodoItem } from './types';
import styles from './SnoozedCard.module.css';

export interface SnoozedCardProps {
  items: TodoItem[];
  onUnsnooze: (id: string) => void;
}

export function SnoozedCard({ items, onUnsnooze }: SnoozedCardProps) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;

  return (
    <div className={styles.card}>
      <button type="button" className={styles.summary} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.arrow} ${open ? styles.open : ''}`} aria-hidden="true">
          &#9654;
        </span>
        <span className={styles.title}>Snoozed</span>
        <span className={styles.count}>{items.length}</span>
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
              >
                &#8617;
              </IconButton>
            </div>
          ))
        : null}
    </div>
  );
}
