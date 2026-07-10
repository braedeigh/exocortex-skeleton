/**
 * ArticlesCard.tsx — every source with fetched full text, ready to
 * annotate: the "article picker" half of the labrador tool. Hidden entirely
 * until at least one text has been fetched.
 */

import { Card } from './Card';
import { articlesWithText, authorsShort } from './helpers';
import { useResearchCtx } from './ResearchContext';
import styles from './ResearchPage.module.css';

export function ArticlesCard() {
  const { state, docTexts, actions } = useResearchCtx();
  const docs = articlesWithText(state.entries, docTexts);
  if (!docs.length) return null;

  return (
    <Card
      cardId="research-articles"
      defaultOpen
      title="Articles"
      count={<>{docs.length} with full text &mdash; pick one to highlight &amp; annotate</>}
    >
      {docs.map(({ doc, entry }) => {
        const m = entry.meta ?? {};
        const title = m.title || entry.text;
        const sub = [authorsShort(m.authors), m.journal, m.published].filter(Boolean).join(' · ');
        return (
          <div key={doc} className={styles.fileRow}>
            <button
              type="button"
              className={`${styles.fileBtn} ${styles.fileBtnCol}`}
              onClick={() => actions.openAnnotator(doc, (title ?? '').slice(0, 60))}
            >
              <span className={styles.fileTitle}>{title}</span>
              {sub ? <span className={styles.filePath}>{sub}</span> : null}
            </button>
            <span className={`${styles.kind} ${styles.kindSource}`}>&#128214; annotate</span>
          </div>
        );
      })}
    </Card>
  );
}
