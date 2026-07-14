/**
 * ThreadsDirectory.tsx — the Threads card plus the new-thread row at the
 * bottom of the main view. Front FILTER pills sit up top (kept as buttons —
 * her call); the threads themselves render as an iMessage-style stack of
 * lines copied from the /sessions terminal switcher (SessionListPage): name,
 * a badge/meta row, and the thread's latest entry as a line-clamped recap.
 *
 * With "All" selected the stack groups under front section labels (a thread
 * carrying several fronts files under its first); a specific filter renders
 * flat. The selected filter is lifted to ResearchPage.tsx so NewThreadRow can
 * read it too (a new thread created while a specific front is selected
 * auto-tags with it).
 */

import { useMemo, useState } from 'react';
import { Card } from './Card';
import { orderedTopics, plural, topicStats } from './helpers';
import { useResearchCtx } from './ResearchContext';
import { useFronts } from './useResearchData';
import { FRONT_EMOJI, type Front } from '../fronts/useFronts';
import type { Entry, Topic } from './types';
import styles from './ResearchPage.module.css';

function topicFronts(t: Topic): string[] {
  return t.fronts ?? [];
}

/** Relative freshness from a 'YYYY-MM-DD HH:MM' stamp, /sessions-style. */
function ago(created: string | undefined): string | null {
  if (!created) return null;
  const ts = new Date(created.replace(' ', 'T')).getTime();
  if (Number.isNaN(ts)) return null;
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Newest entry per topic id — the recap line under each thread name. */
function latestByTopic(entries: Entry[]): Record<string, Entry> {
  const latest: Record<string, Entry> = {};
  for (const e of entries) {
    for (const tid of e.topics ?? []) {
      if (!latest[tid] || (e.created ?? '') > (latest[tid].created ?? '')) latest[tid] = e;
    }
  }
  return latest;
}

function ThreadLine({ topic, latest }: { topic: Topic; latest: Entry | undefined }) {
  const { state, actions } = useResearchCtx();
  const stats = topicStats(topic.id, state.entries);
  const updated = ago(latest?.created);
  return (
    <button type="button" className={styles.threadLine} onClick={() => actions.openThread(topic.id)}>
      <span className={styles.threadLineTop}>
        <span className={styles.threadLineName}>{topic.name}</span>
        <span className={styles.dirChevron}>&#8250;</span>
      </span>
      <span className={styles.threadLineMeta}>
        <span className={styles.threadLineCount}>
          {stats.count} {plural(stats.count, 'entry', 'entries')}
        </span>
        {topic.status !== 'active' ? <span className={styles.threadLineBadge}>{topic.status}</span> : null}
        {stats.unreviewed ? (
          <span className={`${styles.threadLineBadge} ${styles.threadLineBadgeNew}`}>{stats.unreviewed} new</span>
        ) : null}
        {stats.open ? (
          <span className={`${styles.threadLineBadge} ${styles.threadLineBadgeOpen}`}>{stats.open} open</span>
        ) : null}
        {updated ? <span className={styles.threadLineTime}>{updated}</span> : null}
      </span>
      {latest ? (
        <span className={styles.threadLineRecap}>
          {latest.author === 'llm' ? 'Claude: ' : ''}
          {latest.text}
        </span>
      ) : (
        <span className={styles.threadLineRecap}>Nothing here yet.</span>
      )}
    </button>
  );
}

export interface ThreadsDirectoryCardProps {
  frontFilter: string;
  onFrontFilterChange: (id: string) => void;
}

export function ThreadsDirectoryCard({ frontFilter, onFrontFilterChange }: ThreadsDirectoryCardProps) {
  const { state } = useResearchCtx();
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];

  const topics = orderedTopics(state.topics, state.entries);
  const latest = useMemo(() => latestByTopic(state.entries), [state.entries]);

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

  // "All" groups by each topic's first front, section order following
  // fronts.json; frontless topics gather under Uncategorized at the end.
  const sections = useMemo(() => {
    if (frontFilter !== 'all') return null;
    const byFront: Record<string, Topic[]> = {};
    for (const t of filtered) {
      const key = topicFronts(t)[0] ?? '__none__';
      (byFront[key] = byFront[key] ?? []).push(t);
    }
    const out: { front: Front | null; topics: Topic[] }[] = [];
    for (const f of fronts) {
      if (byFront[f.id]) out.push({ front: f, topics: byFront[f.id] });
    }
    if (byFront.__none__) out.push({ front: null, topics: byFront.__none__ });
    return out;
  }, [frontFilter, filtered, fronts]);

  const line = (t: Topic) => <ThreadLine key={t.id} topic={t} latest={latest[t.id]} />;

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
              {FRONT_EMOJI[f.id] ? `${FRONT_EMOJI[f.id]} ` : ''}
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
        sections ? (
          sections.map(({ front, topics: ts }) => (
            <div key={front?.id ?? '__none__'}>
              <div className={styles.threadSection}>
                {front ? `${FRONT_EMOJI[front.id] ? `${FRONT_EMOJI[front.id]} ` : ''}${front.name}` : '🏷️ Uncategorized'}
              </div>
              <div className={styles.threadStack}>{ts.map(line)}</div>
            </div>
          ))
        ) : (
          <div className={styles.threadStack}>{filtered.map(line)}</div>
        )
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
