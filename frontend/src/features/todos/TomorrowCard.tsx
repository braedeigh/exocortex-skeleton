import { fmtTime } from './todoHelpers';
import type { TodoItem } from './types';
import styles from './UpNowCard.module.css';

export interface TomorrowCardProps {
  items: TodoItem[];
  onToggle: (id: string) => void;
  onOpenDetail: (item: TodoItem) => void;
}

/**
 * The look-ahead strip under Up now: items due tomorrow, shown only when
 * there are any. Items also stay in their ladder sections below; this is a
 * digest, not a move — same contract as UpNowCard.
 */
export function TomorrowCard({ items, onToggle, onOpenDetail }: TomorrowCardProps) {
  if (!items.length) return null;

  return (
    <div className={styles.card}>
      <div className={styles.title}>&#127749; Tomorrow</div>
      {items.map((it) => (
        <div className={styles.row} key={it.id}>
          <input
            type="checkbox"
            className={styles.check}
            checked={it.done}
            onChange={() => onToggle(it.id)}
            aria-label={`Done: ${it.text}`}
          />
          <button type="button" className={styles.text} onClick={() => onOpenDetail(it)}>
            {it.text}
          </button>
          <span className={styles.due}>{it.due_time ? fmtTime(it.due_time) : 'tomorrow'}</span>
        </div>
      ))}
    </div>
  );
}
