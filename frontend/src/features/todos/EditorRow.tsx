import { Checkbox } from '../../ui';
import { frontLabel } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import { fmtAddedDate, isOverdue, itemFronts, statusLabel } from './todoHelpers';
import type { TodoItem } from './types';
import styles from './EditorRow.module.css';

export interface EditorRowProps {
  item: TodoItem;
  section: string;
  serverDate: string;
  fronts: Front[];
  snoozed: boolean;
  waiting: boolean;
  /** Select mode: the checkbox becomes the selection mark and the whole row
   * toggles selection instead of opening the detail sheet. */
  selecting: boolean;
  selected: boolean;
  onToggleDone: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onOpen: (item: TodoItem) => void;
}

export function EditorRow({
  item,
  section,
  serverDate,
  fronts,
  snoozed,
  waiting,
  selecting,
  selected,
  onToggleDone,
  onToggleSelect,
  onOpen,
}: EditorRowProps) {
  const overdue = isOverdue(item.due_by, serverDate) && !item.done;

  return (
    <div className={`${styles.row} ${selecting && selected ? styles.selected : ''}`}>
      <Checkbox
        className={styles.checkbox}
        checked={selecting ? selected : item.done}
        onChange={() => (selecting ? onToggleSelect(item.id) : onToggleDone(item.id))}
        aria-label={
          selecting
            ? selected
              ? `Deselect ${item.text}`
              : `Select ${item.text}`
            : item.done
              ? `Mark ${item.text} not done`
              : `Mark ${item.text} done`
        }
      />
      <button
        type="button"
        className={styles.body}
        onClick={() => (selecting ? onToggleSelect(item.id) : onOpen(item))}
      >
        <span className={`${styles.text} ${item.done ? styles.done : ''}`}>{item.text}</span>
        {item.notes ? (
          <span className={styles.notesPreview}>{item.notes.split('\n')[0].trim()}</span>
        ) : null}
        <span className={styles.chips}>
          <span className={`${styles.chip} ${styles.sectionChip}`}>{section}</span>
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
          {item.status && !item.done ? <span className={styles.chip}>{statusLabel(item.status)}</span> : null}
          {snoozed ? (
            <span className={styles.chip}>&#128164; until {fmtAddedDate(item.snoozed_until)}</span>
          ) : null}
          {waiting ? <span className={styles.chip}>&#9203; waiting</span> : null}
        </span>
      </button>
      {!selecting ? (
        <span className={styles.expand} aria-hidden="true">
          &#8250;
        </span>
      ) : null}
    </div>
  );
}
