/**
 * The bar across the top of the journal: previous/next day arrows, the day's
 * name, a "Today" button when you're elsewhere, and icon buttons that open
 * search, the calendar, and the journal's dev notes. It only reports taps;
 * JournalPage.tsx decides what each one does.
 */
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
  onOpenSearch: () => void;
  onOpenCalendar: () => void;
  onOpenDevNotes: () => void;
}

/** "Wednesday, July 8, 2026" — pure display formatting, not a "what day is today" determination. */
function formatDayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function JournalHeader({ date, prev, next, isToday, onPrev, onNext, onToday, onOpenSearch, onOpenCalendar, onOpenDevNotes }: JournalHeaderProps) {
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
      <IconButton
        aria-label="Search the journal"
        title="Search the journal"
        onClick={onOpenSearch}
        data-track="journal-search-open-sheet"
      >
        &#128269;
      </IconButton>
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
