import { fmtAddedDate, isOverdue } from './todoHelpers';
import type { TodoItem } from './types';
import styles from './UpNowCard.module.css';

export interface UpNowCardProps {
  items: TodoItem[];
  serverDate: string;
  onToggle: (id: string) => void;
  onOpenDetail: (item: TodoItem) => void;
}

/**
 * The attention strip at the top of the To Do column: overdue + due-today
 * items, always visible regardless of context gating (deadlines punch
 * through — see gateHides). Items also stay in their ladder sections below;
 * this is a digest, not a move.
 */
export function UpNowCard({ items, serverDate, onToggle, onOpenDetail }: UpNowCardProps) {
  if (!items.length) return null;

  return (
    <div className={styles.card}>
      <div className={styles.title}>&#9889; Up now</div>
      {items.map((it) => {
        const overdue = isOverdue(it.due_by, serverDate);
        return (
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
            <span className={`${styles.due} ${overdue ? styles.overdue : ''}`}>
              {overdue ? `overdue · ${fmtAddedDate(it.due_by)}` : 'today'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
