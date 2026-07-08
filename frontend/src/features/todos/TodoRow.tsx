import { Checkbox } from '../../ui';
import { categoryLabel, fmtAddedDate, isOverdue, statusLabel, themeLabel } from './todoHelpers';
import type { TodoItem } from './types';
import styles from './TodoRow.module.css';

export interface TodoRowProps {
  item: TodoItem;
  serverDate: string;
  draggable?: boolean;
  dragOver?: boolean;
  onToggle: (id: string) => void;
  onOpen: (item: TodoItem) => void;
  onDragStart?: (id: string) => void;
  onDragOverRow?: (id: string) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}

export function TodoRow({
  item,
  serverDate,
  draggable = false,
  dragOver = false,
  onToggle,
  onOpen,
  onDragStart,
  onDragOverRow,
  onDrop,
  onDragEnd,
}: TodoRowProps) {
  const overdue = isOverdue(item.due_by, serverDate) && !item.done;

  return (
    <div
      className={`${styles.row} ${dragOver ? styles.dragOver : ''}`}
      draggable={draggable}
      onDragStart={() => onDragStart?.(item.id)}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverRow?.(item.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop?.();
      }}
      onDragEnd={() => onDragEnd?.()}
    >
      <Checkbox
        className={styles.checkbox}
        checked={item.done}
        onChange={() => onToggle(item.id)}
        aria-label={item.done ? `Mark ${item.text} not done` : `Mark ${item.text} done`}
      />
      <button type="button" className={styles.body} onClick={() => onOpen(item)}>
        <span className={`${styles.text} ${item.done ? styles.done : ''}`}>{item.text}</span>
        {item.due_by || item.theme || (item.status && !item.done) ? (
          <span className={styles.chips}>
            {item.due_by ? (
              <span className={`${styles.chip} ${overdue ? styles.overdue : ''}`}>
                {overdue ? 'overdue · ' : 'due '}
                {fmtAddedDate(item.due_by)}
              </span>
            ) : null}
            {item.theme ? <span className={styles.chip}>{themeLabel(item.theme)}</span> : null}
            {item.status && !item.done ? <span className={styles.chip}>{statusLabel(item.status)}</span> : null}
            {item.category ? <span className={styles.chip}>{categoryLabel(item.category)}</span> : null}
          </span>
        ) : null}
      </button>
      <span className={styles.expand} aria-hidden="true">
        &#8250;
      </span>
    </div>
  );
}
