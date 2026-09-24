/**
 * The bar across the top of the journal: previous/next day arrows, the day's
 * name, a "Today" button when you're elsewhere, the search box
 * (JournalSearchBar.tsx, passed in as `search`), and icon buttons for the
 * calendar and the journal's dev notes. On a phone the search box drops to
 * its own full-width row under the date. It only reports taps;
 * JournalPage.tsx decides what each one does.
 */
import type { ReactNode } from 'react';
import { Button, IconButton } from '../../ui';
import styles from './JournalHeader.module.css';

export interface JournalHeaderProps {
  date: string;
  prev: string | null;
  next: string | null;
  isToday: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  /** The search box, placed beside the date. */
  search: ReactNode;
  onOpenCalendar: () => void;
  onOpenDevNotes: () => void;
}

/** "Wednesday, July 8, 2026" — pure display formatting, not a "what day is today" determination. */
function formatDayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function JournalHeader({ date, prev, next, isToday, onPrev, onNext, onToday, search, onOpenCalendar, onOpenDevNotes }: JournalHeaderProps) {
  return (
    <div className={styles.nav}>
      <IconButton aria-label="Previous day" onClick={onPrev} disabled={!prev} data-track="day-prev">
        &larr;
      </IconButton>
      <div className={styles.title}>{formatDayLabel(date)}</div>
      <IconButton aria-label="Next day" onClick={onNext} disabled={!next} data-track="day-next">
        &rarr;
      </IconButton>
      {!isToday ? (
        <Button variant="ghost" className={styles.todayBtn} onClick={onToday} data-track="day-today">
          Today
        </Button>
      ) : null}
      <div className={styles.search}>{search}</div>
      <IconButton
        aria-label="Open calendar"
        title="Jump to a date"
        onClick={onOpenCalendar}
        data-track="calendar-open"
      >
        &#128197;
      </IconButton>
      <IconButton
        aria-label="Journal dev notes"
        title="Journal dev notes"
        onClick={onOpenDevNotes}
        data-track="dev-notes-open"
      >
        &#128221;
      </IconButton>
    </div>
  );
}
