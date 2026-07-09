import { useEffect, useMemo, useRef, useState } from 'react';
import { carTypeLabel, daysUntil, dueTone, sortEntriesByNextDue } from './carMath';
import type { CarEntry } from './types';
import styles from './CarLogTable.module.css';

/**
 * Maintenance log — port of renderCarLog in static/js/car.js. Sorted soonest
 * next_due first (undated last); overdue dates go red, ≤30 days orange. The
 * old page removed rows with a bare ×; per the React-port convention
 * (NotesBrowserPage and CLAUDE.md's "destructive actions confirm first") the
 * × here two-steps into "Sure?" (3s to revert) before onRemove fires — the
 * page then hides the row behind an undo toast.
 */

interface CarLogTableProps {
  entries: readonly CarEntry[];
  /** Client-local YYYY-MM-DD for the due-soon math (old carDaysUntil used `new Date()`). */
  today: string;
  onRemove: (id: string) => void;
}

export function CarLogTable({ entries, today, onRemove }: CarLogTableProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const sorted = useMemo(() => sortEntriesByNextDue(entries), [entries]);

  function requestRemove(id: string) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmId === id) {
      setConfirmId(null);
      onRemove(id);
      return;
    }
    setConfirmId(id);
    confirmTimer.current = setTimeout(() => setConfirmId(null), 3000);
  }

  if (!sorted.length) {
    return <div className={styles.empty}>No maintenance logged yet.</div>;
  }

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr className={styles.headRow}>
            <th className={styles.th}>Type</th>
            <th className={styles.th}>Date</th>
            <th className={styles.th}>Mileage</th>
            <th className={styles.th}>Next due</th>
            <th className={styles.th}>Notes</th>
            <th className={styles.th} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const tone = dueTone(daysUntil(e.next_due, today));
            const dueClass =
              tone === 'overdue' ? styles.dueOverdue : tone === 'soon' ? styles.dueSoon : '';
            const confirming = confirmId === e.id;
            return (
              <tr key={e.id}>
                <td className={styles.td}>{carTypeLabel(e.type)}</td>
                <td className={styles.td}>{e.date || '—'}</td>
                <td className={styles.td}>{e.mileage != null && e.mileage !== '' ? e.mileage : '—'}</td>
                <td className={`${styles.td} ${dueClass}`}>{e.next_due || '—'}</td>
                <td className={`${styles.td} ${styles.notesCell}`}>{e.notes || ''}</td>
                <td className={`${styles.td} ${styles.removeCell}`}>
                  <button
                    type="button"
                    className={`${styles.removeBtn} ${confirming ? styles.removeSure : ''}`}
                    title="Remove"
                    aria-label={confirming ? 'Confirm remove entry' : 'Remove entry'}
                    onClick={() => requestRemove(e.id)}
                  >
                    {confirming ? 'Sure?' : <>&times;</>}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
