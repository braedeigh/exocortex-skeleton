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
 *
 * Two opt-in props (default off, so ThreadsPage is unchanged):
 *  - `collapsible`: render each dated section as a native <details> collapsed
 *    by default — the wiki wants every section shut on load (not a remembered
 *    open/closed state), so <summary> = the heading, click to reveal the card.
 *  - `order`: 'desc' shows newest sections first (the wiki default); 'asc'
 *    keeps file order (oldest first), which is how the CLI appends them.
 */
export function ThreadCards({
  cards,
  onSourceClick,
  collapsible = false,
  order = 'asc',
}: {
  cards: ThreadFactCard[];
  onSourceClick: (s: ThreadSource) => void;
  collapsible?: boolean;
  order?: 'asc' | 'desc';
}) {
  if (cards.length === 0) {
    return <div className={styles.bodyNote}>No facts recorded yet.</div>;
  }

  // Group consecutive cards that share a heading into one section (matches the
  // old inline "show the heading once per run" logic), so collapse + reordering
  // act on whole dated sections rather than splitting a heading from its cards.
  const sections: { heading: string | null; cards: ThreadFactCard[] }[] = [];
  for (const c of cards) {
    const heading = c.heading || null;
    const last = sections[sections.length - 1];
    if (last && last.heading === heading) last.cards.push(c);
    else sections.push({ heading, cards: [c] });
  }
  if (order === 'desc') sections.reverse();

  function factCard(c: ThreadFactCard, key: number) {
    return (
      <div className={styles.factCard} key={key}>
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
    );
  }

  if (collapsible) {
    return (
      <>
        {sections.map((sec, i) =>
          sec.heading ? (
            <details className={styles.sectionDetails} key={i}>
              <summary className={styles.sectionSummary}>{sec.heading}</summary>
              <div className={styles.sectionBody}>{sec.cards.map((c, j) => factCard(c, j))}</div>
            </details>
          ) : (
            // Headingless section: nothing to collapse under, render open.
            <Fragment key={i}>{sec.cards.map((c, j) => factCard(c, j))}</Fragment>
          ),
        )}
      </>
    );
  }

  return (
    <>
      {sections.map((sec, i) => (
        <Fragment key={i}>
          {sec.heading ? <div className={styles.section}>{sec.heading}</div> : null}
          {sec.cards.map((c, j) => factCard(c, j))}
        </Fragment>
      ))}
    </>
  );
}
