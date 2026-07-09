import { useEffect, useRef, useState } from 'react';
import styles from './BulkActionBar.module.css';

export interface BulkActionBarProps {
  /** How many rows are selected — the bar only renders when > 0. */
  count: number;
  /** Select every row in the current FILTERED list. */
  onSelectAll: () => void;
  onSnooze: () => void;
  onTag: () => void;
  onMove: () => void;
  /** Fires only on the second (confirming) tap of Delete. */
  onDelete: () => void;
}

/**
 * Fixed bottom bar shown while select mode has a non-empty selection.
 * Delete uses the inline two-tap "Sure?" confirm (NotesBrowserPage pattern)
 * instead of a modal — the second tap within 3s commits.
 */
export function BulkActionBar({ count, onSelectAll, onSnooze, onTag, onMove, onDelete }: BulkActionBarProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  function requestDelete() {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmingDelete) {
      setConfirmingDelete(false);
      onDelete();
      return;
    }
    setConfirmingDelete(true);
    confirmTimer.current = setTimeout(() => setConfirmingDelete(false), 3000);
  }

  if (count === 0) return null;

  return (
    <div className={styles.bar}>
      <span className={styles.count}>{count} selected</span>
      <button type="button" className={styles.selectAll} onClick={onSelectAll}>
        Select all
      </button>
      <div className={styles.actions}>
        <button type="button" className={styles.act} onClick={onSnooze}>
          Snooze
        </button>
        <button type="button" className={styles.act} onClick={onTag}>
          Tag
        </button>
        <button type="button" className={styles.act} onClick={onMove}>
          Move
        </button>
        <button
          type="button"
          className={`${styles.act} ${styles.danger} ${confirmingDelete ? styles.sure : ''}`}
          aria-label={confirmingDelete ? `Confirm delete ${count} to-dos` : `Delete ${count} to-dos`}
          onClick={requestDelete}
        >
          {confirmingDelete ? 'Sure?' : 'Delete'}
        </button>
      </div>
    </div>
  );
}
