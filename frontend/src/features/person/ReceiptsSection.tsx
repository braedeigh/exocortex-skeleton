import { mentionNav, type ReceiptNav } from './personLogic';
import type { PersonEntry, PersonMention } from './types';
import styles from './ReceiptsSection.module.css';

export interface ReceiptsSectionProps {
  /** The person's structured "Referenced In" entries, oldest-first (as the API sends them). */
  entries: PersonEntry[];
  /** Loose vault hits, newest-first (as the API sends them). */
  mentions: PersonMention[];
  /** people/views/<slug>.md when the rendered card view exists. */
  cardView: string | null;
  onNav: (nav: ReceiptNav) => void;
}

/**
 * Receipts (port of person.js renderReceipts): the file's own entries
 * newest-first, then everywhere else the name appears, then the card-view
 * link. Journal rows deep-link to that date; anything else opens the keeper
 * file.
 */
export function ReceiptsSection({ entries, mentions, cardView, onNav }: ReceiptsSectionProps) {
  const ownEntries = entries.slice().reverse();

  return (
    <div>
      {ownEntries.length ? (
        <>
          <div className={styles.subhead}>In their file &middot; {ownEntries.length}</div>
          {ownEntries.map((en, i) => (
            <button
              key={`${en.date}-${i}`}
              type="button"
              className={styles.row}
              onClick={() => onNav({ kind: 'journal', date: en.date })}
            >
              <span className={styles.rowDate}>{en.date}</span>
              {en.note ? <span className={styles.rowNote}> {en.note}</span> : null}
            </button>
          ))}
        </>
      ) : null}

      {mentions.length ? (
        <>
          <div className={styles.subhead}>Mentioned elsewhere &middot; {mentions.length}</div>
          {mentions.map((m, i) => (
            <button key={`${m.file}-${i}`} type="button" className={styles.row} onClick={() => onNav(mentionNav(m))}>
              {m.count ? <span className={styles.badge}>&times;{m.count}</span> : null}
              <span className={styles.rowDate}>{m.label}</span>
              <span className={styles.rowSnip}>{m.snippet}</span>
            </button>
          ))}
        </>
      ) : null}

      {cardView ? (
        <button
          type="button"
          className={`${styles.row} ${styles.rowCardView}`}
          onClick={() => onNav({ kind: 'keeper', path: cardView })}
        >
          Card view (verbatim receipts) &rarr;
        </button>
      ) : null}

      {!ownEntries.length && !mentions.length ? (
        <div className={styles.empty}>No references recorded yet.</div>
      ) : null}
    </div>
  );
}
