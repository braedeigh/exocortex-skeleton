import { useEffect, useRef, useState } from 'react';
import { HousingFields } from './HousingFields';
import { STATUS_OPTIONS, normalizeStatus, statusColorVar } from './statusLadder';
import { fieldsFromEntry } from './types';
import type { HousingEntry, PlaceFields } from './types';
import styles from './PlaceCard.module.css';

export interface PlaceCardProps {
  entry: HousingEntry;
  onSetStatus: (id: string, status: string) => void;
  onSaveEdit: (id: string, fields: PlaceFields) => void;
  /** Delete already confirmed on the card — parent runs the undo-toast flow. */
  onDelete: (entry: HousingEntry) => void;
}

/**
 * One place card — port of _housingCard(): status-colored left border, name +
 * listing link, status dropdown, rent · size · area line, notes, and the
 * edit/delete buttons. Editing swaps the card body for the shared field
 * block inline (old .housing-view / .housing-edit toggle). Delete is
 * two-step: 🗑 turns into "Sure?" for 3s before it counts.
 */
export function PlaceCard({ entry, onSetStatus, onSaveEdit, onDelete }: PlaceCardProps) {
  const [fields, setFields] = useState<PlaceFields | null>(null); // non-null = editing
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const color = statusColorVar(entry.status);
  const metaBits = [entry.rent, entry.size, entry.area].filter(Boolean).join(' · ');

  function requestDelete() {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirming) {
      setConfirming(false);
      onDelete(entry);
      return;
    }
    setConfirming(true);
    confirmTimer.current = setTimeout(() => setConfirming(false), 3000);
  }

  function saveEdit() {
    if (!fields) return;
    onSaveEdit(entry.id, fields);
    setFields(null);
  }

  if (fields) {
    return (
      <div className={styles.card}>
        <HousingFields value={fields} onChange={(patch) => setFields((f) => (f ? { ...f, ...patch } : f))} />
        <div className={styles.editActions}>
          <button type="button" className={styles.saveBtn} onClick={saveEdit}>
            Save
          </button>
          <button type="button" className={styles.cancelBtn} onClick={() => setFields(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.nameRow}>
        {/* Status color rides the name text (the old colored left border is gone). */}
        <div className={styles.name} style={{ color }}>
          {entry.name}
        </div>
        {entry.link ? (
          <a
            className={styles.link}
            href={entry.link}
            target="_blank"
            rel="noopener noreferrer"
            title="Open listing"
          >
            &#128279;
          </a>
        ) : null}
      </div>
      <div className={styles.statusRow}>
        <select
          className={styles.statusSelect}
          style={{ color }}
          value={normalizeStatus(entry.status)}
          onChange={(e) => onSetStatus(entry.id, e.target.value)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {entry.avail ? <span className={styles.avail}>avail {entry.avail}</span> : null}
      </div>
      {metaBits ? <div className={styles.meta}>{metaBits}</div> : null}
      {entry.notes ? <div className={styles.notes}>{entry.notes}</div> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.actBtn}
          title="Edit"
          aria-label={`Edit ${entry.name}`}
          onClick={() => {
            if (confirmTimer.current) clearTimeout(confirmTimer.current);
            setConfirming(false);
            setFields(fieldsFromEntry(entry));
          }}
        >
          &#9998;
        </button>
        <button
          type="button"
          className={`${styles.actBtn} ${styles.deleteBtn} ${confirming ? styles.sure : ''}`}
          title="Delete"
          aria-label={confirming ? `Confirm delete ${entry.name}` : `Delete ${entry.name}`}
          onClick={requestDelete}
        >
          {confirming ? 'Sure?' : <>&#128465;</>}
        </button>
      </div>
    </div>
  );
}
