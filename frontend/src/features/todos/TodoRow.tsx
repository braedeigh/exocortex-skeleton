import type { PointerEvent as ReactPointerEvent } from 'react';
import { Checkbox } from '../../ui';
import { frontLabel } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import { fmtAddedDate, isOverdue, itemFronts } from './todoHelpers';
import type { TodoItem } from './types';
import styles from './TodoRow.module.css';

export interface TodoRowProps {
  item: TodoItem;
  serverDate: string;
  fronts: Front[];
  dragOver?: boolean;
  dragging?: boolean;
  onToggle: (id: string) => void;
  onOpen: (item: TodoItem) => void;
  onSubtaskToggle: (parentId: string, subId: string) => void;
  onHandlePointerDown?: (e: ReactPointerEvent<HTMLDivElement>, id: string) => void;
  rowRef?: (el: HTMLDivElement | null) => void;
}

export function TodoRow({
  item,
  serverDate,
  fronts,
  dragOver = false,
  dragging = false,
  onToggle,
  onOpen,
  onSubtaskToggle,
  onHandlePointerDown,
  rowRef,
}: TodoRowProps) {
  const overdue = isOverdue(item.due_by, serverDate) && !item.done;

  return (
    <div
      ref={rowRef}
      className={`${styles.row} ${dragOver ? styles.dragOver : ''} ${dragging ? styles.dragging : ''}`}
    >
      {onHandlePointerDown ? (
        <div
          className={styles.handle}
          role="button"
          aria-label={`Drag to reorder ${item.text}`}
          title="Drag to reorder"
          onPointerDown={(e) => onHandlePointerDown(e, item.id)}
        >
          &#8942;&#8942;
        </div>
      ) : null}
      <Checkbox
        className={styles.checkbox}
        checked={item.done}
        onChange={() => onToggle(item.id)}
        aria-label={item.done ? `Mark ${item.text} not done` : `Mark ${item.text} done`}
      />
      <button type="button" className={styles.body} onClick={() => onOpen(item)}>
        <span className={`${styles.text} ${item.done ? styles.done : ''}`}>{item.text}</span>
        {item.notes ? (
          <span className={styles.notesPreview}>{item.notes.split('\n')[0].trim()}</span>
        ) : null}
        {item.due_by || itemFronts(item).length ? (
          <span className={styles.chips}>
            {item.due_by ? (
              <span className={`${styles.chip} ${overdue ? styles.overdue : ''}`}>
                {overdue ? 'overdue · ' : 'due '}
                {fmtAddedDate(item.due_by)}
              </span>
            ) : null}
            {/* One chip per front, capped at 2 + a "+N" overflow so a
                heavily-tagged item can't flood the row. */}
            {itemFronts(item)
              .slice(0, 2)
              .map((f) => (
                <span key={f} className={styles.chip}>
                  {frontLabel(fronts, f)}
                </span>
              ))}
            {itemFronts(item).length > 2 ? (
              <span className={styles.chip}>+{itemFronts(item).length - 2}</span>
            ) : null}
          </span>
        ) : null}
      </button>
      <span className={styles.expand} aria-hidden="true">
        &#8250;
      </span>
      {item.subtasks?.length ? (
        <div className={styles.subtasks}>
          {item.subtasks.map((sub) => (
            <div key={sub.id} className={styles.subtaskRow}>
              <Checkbox
                className={styles.subtaskCheckbox}
                checked={sub.done}
                onChange={() => onSubtaskToggle(item.id, sub.id)}
                aria-label={sub.done ? `Mark ${sub.text} not done` : `Mark ${sub.text} done`}
              />
              <span className={`${styles.subtaskText} ${sub.done ? styles.done : ''}`}>{sub.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
