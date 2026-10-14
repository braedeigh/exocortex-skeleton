/**
 * The stack of fact sheets on a person's page.
 *
 * A person's sheets are short "current facts" cards written by a night helper
 * (a cricket), one row each in the database and never rewritten
 * (personsheets.py). Each is five labelled lines: Who, Pronouns, Tied to, Now,
 * Last contact. This shows the newest one in full, and a button under it that
 * opens the older ones beneath, newest first. Each sheet shows the day it was
 * written and the days it was based on. A person with no sheet shows nothing.
 *
 * Touches: PersonPage.tsx (renders this under its own "Fact sheet" title and
 * hands it the rows), types.ts (the shape of a row), ../threads/ThreadSummaries.tsx
 * (the same stack look, and the author and source-day helpers reused here).
 *
 * Prompt: "Each summary sits above an old summary and I can read past
 * summaries. Don't make them too long." (a sheet per person, same stack)
 */
import { useState } from 'react';
import { authorLabel, sourceDays } from '../threads/ThreadSummaries';
import type { PersonSheet } from './types';
import styles from './PersonSheets.module.css';

export interface PersonSheetsProps {
  /** Newest first, as the server sends them. */
  sheets: PersonSheet[];
}

/** "Who: a friend" -> {label: "Who", value: "a friend"}; a line with no
 * ": " in it comes back whole, with no label. */
export function splitSheetLine(line: string): { label: string | null; value: string } {
  const at = line.indexOf(': ');
  if (at === -1) return { label: null, value: line };
  return { label: line.slice(0, at), value: line.slice(at + 2) };
}

export function PersonSheets({ sheets }: PersonSheetsProps) {
  const [showOlder, setShowOlder] = useState(false);
  if (sheets.length === 0) return null;
  const [newest, ...older] = sheets;

  return (
    <div className={styles.stack}>
      <SheetCard sheet={newest} newest />
      {older.length > 0 ? (
        <button
          type="button"
          className={styles.olderToggle}
          aria-expanded={showOlder}
          onClick={() => setShowOlder((open) => !open)}
        >
          {showOlder
            ? 'Hide earlier sheets'
            : `Show ${older.length} earlier ${older.length === 1 ? 'sheet' : 'sheets'}`}
        </button>
      ) : null}
      {showOlder ? older.map((sheet) => <SheetCard key={sheet.id} sheet={sheet} />) : null}
    </div>
  );
}

interface SheetCardProps {
  sheet: PersonSheet;
  /** The top of the stack: drawn at full strength; older ones are quieter. */
  newest?: boolean;
}

function SheetCard({ sheet, newest = false }: SheetCardProps) {
  const days = sourceDays(sheet.based_on);
  const lines = sheet.body.split('\n').filter((line) => line.trim() !== '');
  return (
    <article className={newest ? styles.card : `${styles.card} ${styles.older}`}>
      <div className={styles.meta}>
        <span className={styles.label}>{newest ? 'Latest' : 'Earlier'}</span>
        <span className={styles.byline}>
          {authorLabel(sheet.author)} · {sheet.written_at.slice(0, 10)}
        </span>
      </div>
      <dl className={styles.lines}>
        {lines.map((line, position) => {
          const { label, value } = splitSheetLine(line);
          return (
            <div key={position} className={styles.line}>
              {label ? <dt className={styles.lineLabel}>{label}</dt> : null}
              <dd className={styles.lineValue}>{value}</dd>
            </div>
          );
        })}
      </dl>
      {days.length > 0 ? <p className={styles.sources}>Based on {days.join(' · ')}</p> : null}
    </article>
  );
}
