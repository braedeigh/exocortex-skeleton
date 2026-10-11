/**
 * An entry's edit history: what it says now, then what it said before each
 * change, newest change first, each with the date and time it was made.
 * Opened from the "edited" chip on a card (EntryCard.tsx).
 *
 * The old text comes from the edit log the journal engine keeps
 * (tools/stream/stream.py writes it before every change; routes/cards.py
 * serves it at GET /api/cards/<id>/history). Read-only: this shows history,
 * it doesn't restore it.
 *
 * Prompt: "any changes i want to be marked as edits on the date they were
 * made" — keeping the old text.
 */
import { useQuery } from '@tanstack/react-query';
import { getCardHistory } from '../../api/endpoints';
import { Sheet } from '../../ui';
import styles from './EditHistorySheet.module.css';

export interface EditHistorySheetProps {
  cardId: string;
  /** The entry's text as it is now. */
  currentBody: string;
  open: boolean;
  onClose: () => void;
}

/** "Thu, Sep 24, 2026 · 4:05 PM" from "YYYY-MM-DD HH:MM:SS" — display only. */
export function formatEditTime(stamp: string): string {
  const date = new Date(`${stamp.slice(0, 10)}T12:00:00`);
  const day = Number.isNaN(date.getTime())
    ? stamp.slice(0, 10)
    : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const hours = parseInt(stamp.slice(11, 13), 10);
  if (Number.isNaN(hours)) return day;
  return `${day} · ${hours % 12 || 12}:${stamp.slice(14, 16)} ${hours >= 12 ? 'PM' : 'AM'}`;
}

export function EditHistorySheet({ cardId, currentBody, open, onClose }: EditHistorySheetProps) {
  const history = useQuery({
    queryKey: ['journal', 'card-history', cardId],
    queryFn: ({ signal }) => getCardHistory(cardId, signal),
    enabled: open,
  });
  const versions = [...(history.data?.versions ?? [])].reverse();

  return (
    <Sheet open={open} onClose={onClose} title="Edit history">
      <div className={styles.version}>
        <div className={styles.label}>Now</div>
        <div className={styles.text}>{currentBody}</div>
      </div>
      {history.isPending ? <p className={styles.status}>Loading…</p> : null}
      {history.isError ? <p className={styles.status}>Couldn&apos;t load the history.</p> : null}
      {versions.map((version) => (
        <div key={version.edited_at} className={styles.version}>
          <div className={styles.label}>Before the edit on {formatEditTime(version.edited_at)}</div>
          <div className={`${styles.text} ${styles.old}`}>{version.before}</div>
        </div>
      ))}
    </Sheet>
  );
}
