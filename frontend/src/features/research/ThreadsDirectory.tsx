/**
 * ThreadsDirectory.tsx — the Threads card (one row per thread, tap to
 * enter) plus the new-thread row at the bottom of the main view. Threads
 * order active → dormant → settled, most recently touched first; badges
 * surface queued, unreviewed, and open counts.
 */

import { useState } from 'react';
import { Card } from './Card';
import { orderedTopics, plural, topicStats } from './helpers';
import { useResearchCtx } from './ResearchContext';
import styles from './ResearchPage.module.css';

export function ThreadsDirectoryCard() {
  const { state, actions } = useResearchCtx();
  const topics = orderedTopics(state.topics, state.entries);

  return (
    <Card cardId="research-threads" defaultOpen title="Threads" count={topics.length}>
      {topics.length ? (
        topics.map((t) => {
          const stats = topicStats(t.id, state.entries);
          return (
            <button type="button" key={t.id} className={styles.dirRow} onClick={() => actions.openThread(t.id)}>
              <span className={styles.grow}>
                <span className={styles.dirName}>
                  {t.name}
                  <span className={styles.cardCount}>
                    {stats.count} {plural(stats.count, 'entry', 'entries')}
                  </span>
                </span>
                {t.status !== 'active' ? <span className={styles.dirStatus}>&middot; {t.status}</span> : null}
              </span>
              <span className={styles.dirBadges}>
                {stats.flagged ? <span className={styles.dirFlag}>&#9873; {stats.flagged}</span> : null}
                {stats.unreviewed ? <span className={styles.dirUnreviewed}>{stats.unreviewed} new</span> : null}
                {stats.open ? <span className={styles.dirFlag}>{stats.open} open</span> : null}
              </span>
              <span className={styles.dirChevron}>&#8250;</span>
            </button>
          );
        })
      ) : (
        <div className={styles.emptyNote}>No threads yet &mdash; add one below.</div>
      )}
    </Card>
  );
}

export function NewThreadRow() {
  const { mutations, push } = useResearchCtx();
  const [name, setName] = useState('');

  function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      push('Name the thread first.');
      return;
    }
    mutations.addTopic.mutate(trimmed, { onSuccess: () => setName('') });
  }

  return (
    <div className={styles.newTopicRow}>
      <input
        type="text"
        className={styles.newTopicInput}
        placeholder="New thread name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') create();
        }}
      />
      <button type="button" className={styles.primaryBtn} onClick={create}>
        New thread
      </button>
    </div>
  );
}
