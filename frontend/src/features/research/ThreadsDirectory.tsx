/**
 * ThreadsDirectory.tsx — the Threads card (one row per thread, tap to
 * enter) plus the new-thread row at the bottom of the main view. Threads
 * order active → dormant → settled, most recently touched first; badges
 * surface queued, unreviewed, and open counts.
 *
 * A row of front FILTER pills (from the shared fronts vocabulary,
 * routes/fronts.py) sits above the list — "All" + one pill per front that's
 * actually in use by a topic, + "Unassigned" if some topic carries none. The
 * selected filter is lifted to ResearchPage.tsx so NewThreadRow can read it
 * too (a new thread created while a specific front is selected auto-tags
 * with it).
 */

import { useMemo, useState } from 'react';
import { Card } from './Card';
import { orderedTopics, plural, topicStats } from './helpers';
import { useResearchCtx } from './ResearchContext';
import { useFronts } from './useResearchData';
import type { Topic } from './types';
import styles from './ResearchPage.module.css';

function topicFronts(t: Topic): string[] {
  return t.fronts ?? [];
}

export interface ThreadsDirectoryCardProps {
  frontFilter: string;
  onFrontFilterChange: (id: string) => void;
}

export function ThreadsDirectoryCard({ frontFilter, onFrontFilterChange }: ThreadsDirectoryCardProps) {
  const { state, actions } = useResearchCtx();
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];
  const frontNameById = useMemo(() => Object.fromEntries(fronts.map((f) => [f.id, f.name])), [fronts]);

  const topics = orderedTopics(state.topics, state.entries);

  const usedFrontIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of topics) for (const fid of topicFronts(t)) ids.add(fid);
    return ids;
  }, [topics]);
  const hasUnassigned = useMemo(() => topics.some((t) => topicFronts(t).length === 0), [topics]);
  const filterPills = fronts.filter((f) => usedFrontIds.has(f.id));

  const filtered = topics.filter((t) => {
    if (frontFilter === 'all') return true;
    if (frontFilter === 'unassigned') return topicFronts(t).length === 0;
    return topicFronts(t).includes(frontFilter);
  });

  return (
    <Card cardId="research-threads" defaultOpen title="Threads" count={topics.length}>
      {filterPills.length || hasUnassigned ? (
        <div className={styles.composerChips}>
          <button
            type="button"
            className={`${styles.chip} ${frontFilter === 'all' ? styles.chipActive : ''}`}
            onClick={() => onFrontFilterChange('all')}
          >
            All
          </button>
          {filterPills.map((f) => (
            <button
              type="button"
              key={f.id}
              className={`${styles.chip} ${frontFilter === f.id ? styles.chipActive : ''}`}
              onClick={() => onFrontFilterChange(f.id)}
            >
              {f.name}
            </button>
          ))}
          {hasUnassigned ? (
            <button
              type="button"
              className={`${styles.chip} ${frontFilter === 'unassigned' ? styles.chipActive : ''}`}
              onClick={() => onFrontFilterChange('unassigned')}
            >
              Unassigned
            </button>
          ) : null}
        </div>
      ) : null}
      {filtered.length ? (
        filtered.map((t) => {
          const stats = topicStats(t.id, state.entries);
          const tFrontNames = topicFronts(t)
            .map((fid) => frontNameById[fid])
            .filter((name): name is string => Boolean(name));
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
                {tFrontNames.length ? (
                  <span className={styles.dirFronts}>
                    {tFrontNames.map((name) => (
                      <span key={name} className={styles.dirFrontChip}>
                        {name}
                      </span>
                    ))}
                  </span>
                ) : null}
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
        <div className={styles.emptyNote}>
          {topics.length ? 'No threads match this front.' : 'No threads yet — add one below.'}
        </div>
      )}
    </Card>
  );
}

export interface NewThreadRowProps {
  frontFilter: string;
}

export function NewThreadRow({ frontFilter }: NewThreadRowProps) {
  const { mutations, push } = useResearchCtx();
  const [name, setName] = useState('');

  function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      push('Name the thread first.');
      return;
    }
    const fronts = frontFilter !== 'all' && frontFilter !== 'unassigned' ? [frontFilter] : undefined;
    mutations.addTopic.mutate({ name: trimmed, fronts }, { onSuccess: () => setName('') });
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
