import { Fragment } from 'react';
import type { ThreadFactCard, ThreadSource } from '../journal/types';
import styles from './ThreadsPage.module.css';

/**
 * ThreadCards — the fact-card renderer shared by ThreadsPage's expanded
 * thread body and the wiki's per-thread article (WikiThread.tsx): dated
 * section headings, her verbatim text, routable source chips. Extracted out
 * of ThreadsPage's ThreadBody so the two surfaces render a thread's cited
 * facts identically instead of two copies of the same markup drifting apart
 * — reuses ThreadsPage.module.css's card styles too, not a second stylesheet.
 */
export function ThreadCards({
  cards,
  onSourceClick,
}: {
  cards: ThreadFactCard[];
  onSourceClick: (s: ThreadSource) => void;
}) {
  if (cards.length === 0) {
    return <div className={styles.bodyNote}>No facts recorded yet.</div>;
  }

  let lastHeading: string | null = null;

  return (
    <>
      {cards.map((c, i) => {
        const showHeading = !!c.heading && c.heading !== lastHeading;
        lastHeading = c.heading || lastHeading;
        return (
          <Fragment key={i}>
            {showHeading ? <div className={styles.section}>{c.heading}</div> : null}
            <div className={styles.factCard}>
              {c.text ? <div className={styles.factText}>{c.text}</div> : null}
              {c.sources.length > 0 ? (
                <div className={styles.sources}>
                  {c.sources.map((s, j) =>
                    s.kind === 'keeper' ? (
                      <a key={j} className={styles.sourceChip} href={`/files?path=${encodeURIComponent(s.val)}`}>
                        {s.label} &rarr;
                      </a>
                    ) : (
                      <button key={j} type="button" className={styles.sourceChip} onClick={() => onSourceClick(s)}>
                        {s.label} &rarr;
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
