/**
 * The stack of summaries at the top of a thread's page.
 *
 * A thread's summaries are short pieces of prose written by the Keeper or by
 * a night helper (a cricket), kept in the database one row each and never
 * rewritten (threadsummaries.py). This shows the newest one in full, and a
 * button under it that opens the older ones beneath, newest first. A summary
 * written because the thread changed status says so beside its date. A thread
 * nobody has summarised shows nothing here.
 *
 * Touches: ThreadJournalPage.tsx (the page that renders this and hands it the
 * rows), ../journal/types.ts (the shape of a row).
 *
 * Prompt: "Each summary sits above an old summary and I can read past
 * summaries. Don't make them too long."
 */
import { useState } from 'react';
import type { ThreadSummary } from '../journal/types';
import styles from './ThreadSummaries.module.css';

export interface ThreadSummariesProps {
  /** Newest first, as the server sends them. */
  summaries: ThreadSummary[];
  /** "2026-10-06" -> "Oct 6" — the page's own day formatter. */
  formatDay: (day: string) => string;
}

/** "keeper" -> "Keeper"; "cricket:thread-helper" -> "Cricket". */
export function authorLabel(author: string): string {
  if (author === 'keeper') return 'Keeper';
  if (author.startsWith('cricket:')) return 'Cricket';
  return author;
}

/**
 * The days a summary was based on, each once, in order.
 * A source is a card id ("2026-07-13.2220b") or a bare day; both start with
 * the day, so the first ten characters are the day either way.
 */
export function sourceDays(basedOn: string[]): string[] {
  return [...new Set(basedOn.map((source) => source.slice(0, 10)))].sort();
}

/** What to print beside a summary written because the thread changed status. */
export function statusLabel(status: string | null): string | null {
  if (status === 'active') return 'active again';
  return status || null;
}

export function ThreadSummaries({ summaries, formatDay }: ThreadSummariesProps) {
  const [showOlder, setShowOlder] = useState(false);
  if (summaries.length === 0) return null;
  const [newest, ...older] = summaries;

  return (
    <section className={styles.stack} aria-label="Summaries of this thread">
      <SummaryCard summary={newest} formatDay={formatDay} newest />
      {older.length > 0 ? (
        <button
          type="button"
          className={styles.olderToggle}
          aria-expanded={showOlder}
          onClick={() => setShowOlder((open) => !open)}
        >
          {showOlder
            ? 'Hide earlier summaries'
            : `Show ${older.length} earlier ${older.length === 1 ? 'summary' : 'summaries'}`}
        </button>
      ) : null}
      {showOlder
        ? older.map((summary) => <SummaryCard key={summary.id} summary={summary} formatDay={formatDay} />)
        : null}
    </section>
  );
}

interface SummaryCardProps {
  summary: ThreadSummary;
  formatDay: (day: string) => string;
  /** The top of the stack: drawn at full strength; older ones are quieter. */
  newest?: boolean;
}

function SummaryCard({ summary, formatDay, newest = false }: SummaryCardProps) {
  const days = sourceDays(summary.based_on);
  const status = statusLabel(summary.status);
  return (
    <article className={newest ? styles.card : `${styles.card} ${styles.older}`}>
      <div className={styles.meta}>
        <span className={styles.label}>{newest ? 'Summary' : 'Earlier summary'}</span>
        <span className={styles.byline}>
          {authorLabel(summary.author)} · {formatDay(summary.written_at.slice(0, 10))}
        </span>
        {status ? <span className={styles.status}>{status}</span> : null}
      </div>
      <p className={styles.body}>{summary.body}</p>
      {days.length > 0 ? (
        <p className={styles.sources}>Based on {days.map(formatDay).join(' · ')}</p>
      ) : null}
    </article>
  );
}
