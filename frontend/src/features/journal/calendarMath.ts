/**
 * calendarMath.ts — the math behind the little month calendar in the journal.
 *
 * Plain English: when you pop open the calendar to jump to a day, this file
 * builds the grid — how many blank squares before the 1st, how many days in
 * the month, which squares have a journal entry (so they're clickable), which
 * one is today, which one you've got selected. It also does the "< prev /
 * next >" month arrows. Pure math: it hands back a list of cells, and the
 * calendar UI draws them.
 *
 * One honest thing worth keeping: it only ever builds `Date` from plain
 * (year, month, day) numbers to ask "what weekday? how many days?" — it never
 * parses a timestamp string, so there's no timezone weirdness here. ("Today"
 * is the exception — that always comes in from the server as a string.)
 *
 * Touches: nothing else in the app — it's self-contained. The journal's
 * CalendarOverlay calls buildCalendarCells() / addMonths() and renders them.
 *
 * (Predates the prompt-logging rule, so no captured prompt — future changes log theirs.)
 */

export interface CalendarMonth {
  year: number;
  /** 0-11 */
  month: number;
}

export interface CalendarCell {
  day: number | null;
  date: string | null;
  hasEntry: boolean;
  isToday: boolean;
  isSelected: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function dateStr(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** Add `delta` months, rolling the year over as needed. */
export function addMonths({ year, month }: CalendarMonth, delta: number): CalendarMonth {
  let y = year;
  let m = month + delta;
  while (m < 0) {
    m += 12;
    y -= 1;
  }
  while (m > 11) {
    m -= 12;
    y += 1;
  }
  return { year: y, month: m };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Monday-first day-of-week (0=Mon..6=Sun) of the month's 1st. */
export function startDow(year: number, month: number): number {
  const jsDow = new Date(year, month, 1).getDay(); // 0=Sun..6=Sat
  return (jsDow + 6) % 7;
}

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

/**
 * Full grid for one month: leading blank cells for the offset, then one cell
 * per day. Only dates present in `journalDates` are considered to "have an
 * entry" (clickable in the UI).
 */
export function buildCalendarCells(
  year: number,
  month: number,
  journalDates: ReadonlySet<string>,
  today: string,
  selected: string | null,
): CalendarCell[] {
  const cells: CalendarCell[] = [];
  const blanks = startDow(year, month);
  for (let i = 0; i < blanks; i++) {
    cells.push({ day: null, date: null, hasEntry: false, isToday: false, isSelected: false });
  }
  const total = daysInMonth(year, month);
  for (let day = 1; day <= total; day++) {
    const ds = dateStr(year, month, day);
    cells.push({
      day,
      date: ds,
      hasEntry: journalDates.has(ds),
      isToday: ds === today,
      isSelected: ds === selected,
    });
  }
  return cells;
}
