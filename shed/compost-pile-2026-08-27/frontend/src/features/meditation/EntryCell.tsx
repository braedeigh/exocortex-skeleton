import { IconButton } from '../../ui';
import { formatEntryDate, medTypeLabel } from './practiceHelpers';
import type { MeditationEntry } from './types';
import styles from './EntryCell.module.css';

export interface EntryCellProps {
  entry: MeditationEntry;
  /** Opens the two-step confirm; actual removal happens there. */
  onRemove: (entry: MeditationEntry) => void;
}

/**
 * One dated cell in the Practice stream — port of the cell markup in
 * renderMeditationStream(). Notes are plain text rendered pre-wrap (the old
 * page escaped them; markdown only applies to deity bodies). The old faint
 * 16px × is now a full IconButton per the house delete-button rule.
 */
export function EntryCell({ entry, onRemove }: EntryCellProps) {
  const types = entry.types || [];
  const hasDuration = entry.duration_min != null && entry.duration_min !== '';

  return (
    <div className={styles.cell}>
      <div className={styles.head}>
        <div className={styles.meta}>
          <span className={styles.date}>{formatEntryDate(entry.date)}</span>
          {types.map((t) => (
            <span key={t} className={styles.tagPill}>
              {medTypeLabel(t)}
            </span>
          ))}
          {hasDuration ? <span className={styles.duration}>&middot; {String(entry.duration_min)} min</span> : null}
        </div>
        <IconButton aria-label="Remove cell" title="Remove" danger onClick={() => onRemove(entry)}>
          &times;
        </IconButton>
      </div>
      {entry.notes ? (
        <div className={styles.notes}>{entry.notes}</div>
      ) : (
        <div className={styles.noNotes}>(no notes)</div>
      )}
    </div>
  );
}
