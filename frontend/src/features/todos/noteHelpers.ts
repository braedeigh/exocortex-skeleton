/**
 * Shared logic for the floating notes pill (NotesPill/NotesPanel, mounted on
 * /todos) and the /notes browser page (features/notes/NotesBrowserPage) —
 * sort persistence, age formatting, and the "is this note long enough to
 * clamp" heuristic. Kept here rather than duplicated so both surfaces read
 * and write the same 'np-sort' localStorage key and agree on what counts as
 * a long note.
 */

export type SortDir = 'newest' | 'oldest';

export const SORT_STORAGE_KEY = 'np-sort';

export function readStoredSort(): SortDir {
  try {
    return localStorage.getItem(SORT_STORAGE_KEY) === 'oldest' ? 'oldest' : 'newest';
  } catch {
    return 'newest';
  }
}

export function writeStoredSort(sort: SortDir): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch {
    // localStorage unavailable — sort just won't persist across visits
  }
}

/**
 * Sorts a copy of `notes` by their `created` string. "YYYY-MM-DD HH:MM"
 * sorts correctly as a plain string, so no date parsing is needed. Notes
 * with an empty/missing `created` always sort to the end, regardless of
 * direction — an unknown date is neither "newest" nor "oldest".
 */
export function sortNotesByCreated<T extends { created: string }>(notes: readonly T[], sort: SortDir): T[] {
  return notes.slice().sort((a, b) => {
    const ca = String(a.created || '');
    const cb = String(b.created || '');
    if (ca === cb) return 0;
    if (!ca) return 1;
    if (!cb) return -1;
    return sort === 'newest' ? (ca < cb ? 1 : -1) : ca < cb ? -1 : 1;
  });
}

const LONG_NOTE_CHARS = 180;
const LONG_NOTE_LINES = 3;

/**
 * Heuristic for "would this note overflow a 3-line clamp" — drives whether a
 * note gets the clamp + tap-to-expand treatment at all. Short notes render
 * whole with no affordance.
 */
export function isLongNote(text: string): boolean {
  if (text.length > LONG_NOTE_CHARS) return true;
  return text.split('\n').length > LONG_NOTE_LINES;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Formats a note's `created` field ("YYYY-MM-DD HH:MM", local time) as a
 * short relative age: "now", "12m", "2h", "3d", or "may 12" once it's more
 * than ~2 weeks old. Empty or unparseable input returns ''.
 */
export function formatNoteAge(created: string, now: Date = new Date()): string {
  const trimmed = (created || '').trim();
  if (!trimmed) return '';
  const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 14) return `${diffDay}d`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
