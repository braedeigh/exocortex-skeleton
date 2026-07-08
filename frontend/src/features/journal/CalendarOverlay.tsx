import { useMemo } from 'react';
import { IconButton, Sheet } from '../../ui';
import { WEEKDAY_LABELS, addMonths, buildCalendarCells, monthLabel } from './calendarMath';
import type { CalendarMonth } from './calendarMath';
import styles from './CalendarOverlay.module.css';

export interface CalendarOverlayProps {
  open: boolean;
  onClose: () => void;
  month: CalendarMonth;
  onMonthChange: (month: CalendarMonth) => void;
  journalDates: ReadonlySet<string>;
  today: string;
  selected: string | null;
  onSelect: (date: string) => void;
}

export function CalendarOverlay({ open, onClose, month, onMonthChange, journalDates, today, selected, onSelect }: CalendarOverlayProps) {
  const cells = useMemo(
    () => buildCalendarCells(month.year, month.month, journalDates, today, selected),
    [month, journalDates, today, selected],
  );

  return (
    <Sheet open={open} onClose={onClose} title="Jump to a date">
      <div className={styles.header}>
        <IconButton aria-label="Previous month" onClick={() => onMonthChange(addMonths(month, -1))}>
          &larr;
        </IconButton>
        <span className={styles.monthLabel}>{monthLabel(month.year, month.month)}</span>
        <IconButton aria-label="Next month" onClick={() => onMonthChange(addMonths(month, 1))}>
          &rarr;
        </IconButton>
      </div>
      <div className={styles.grid}>
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i} className={styles.dow}>
            {d}
          </div>
        ))}
        {cells.map((cell, i) =>
          cell.day === null ? (
            <div key={i} className={styles.empty} />
          ) : (
            <button
              key={i}
              type="button"
              disabled={!cell.hasEntry}
              className={[
                styles.day,
                cell.hasEntry ? styles.hasEntry : '',
                cell.isToday ? styles.today : '',
                cell.isSelected ? styles.selected : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => cell.date && onSelect(cell.date)}
            >
              {cell.day}
            </button>
          ),
        )}
      </div>
    </Sheet>
  );
}
