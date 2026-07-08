/**
 * refTargets.ts — pure classification/labeling for "ref" card targets
 * (Card.refs entries). A ref target string is always one of:
 *   - a journal date "YYYY-MM-DD"
 *   - a person file path "people/<slug>.md"
 *   - any other vault-relative file path (e.g. "THREADS.md")
 * No Date()/timezone parsing anywhere here — dates stay plain strings,
 * sliced the same way as the rest of the journal feature (see EntryCard's
 * cardClock, calendarMath's dateStr).
 */

export interface DateRefTarget {
  type: 'date';
  date: string;
}

export interface PersonRefTarget {
  type: 'person';
  slug: string;
}

export interface FileRefTarget {
  type: 'file';
  path: string;
}

export type RefTarget = DateRefTarget | PersonRefTarget | FileRefTarget;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERSON_RE = /^people\/([^/]+)\.md$/;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Classify a raw ref string (from Card.refs) into its target kind. */
export function classifyRef(target: string): RefTarget {
  if (DATE_RE.test(target)) return { type: 'date', date: target };
  const personMatch = PERSON_RE.exec(target);
  if (personMatch) return { type: 'person', slug: personMatch[1] };
  return { type: 'file', path: target };
}

/** "2026-05-14" -> "May 14" — string ops on the date parts, no Date(). */
function dateLabel(date: string): string {
  const monthIdx = parseInt(date.slice(5, 7), 10) - 1;
  const day = parseInt(date.slice(8, 10), 10);
  const name = MONTH_NAMES[monthIdx];
  if (!name || Number.isNaN(day)) return date;
  return `${name} ${day}`;
}

/** "john-doe" / "john_doe" -> "John Doe" */
function personLabel(slug: string): string {
  const words = slug.split(/[-_]+/).filter(Boolean);
  if (!words.length) return slug;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** "Journal/Daily/THREADS.md" -> "THREADS.md" */
function fileBasename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Short chip label for an already-classified ref target. */
export function refLabel(target: RefTarget): string {
  switch (target.type) {
    case 'date':
      return dateLabel(target.date);
    case 'person':
      return personLabel(target.slug);
    case 'file':
      return fileBasename(target.path);
  }
}
