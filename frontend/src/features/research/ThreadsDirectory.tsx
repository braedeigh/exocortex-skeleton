/**
 * ThreadsDirectory.tsx — the Threads card, the whole directory view now that
 * search/questions/unfiled/articles/library are gone (phase ① of the
 * redesign). Front FILTER pills sit up top (kept as buttons — her call),
 * with a plain text filter above them; the threads themselves always render
 * as a flat stack of iMessage-style lines copied from the /sessions terminal
 * switcher (SessionListPage): name, a badge/meta row, and the thread's
 * latest entry as a line-clamped recap. She'd rather see which front a
 * thread is in via a small tap-to-filter chip on the row than have the list
 * chopped into front sections, so there's no grouping here — just a sort
 * control to browse the flat list a different way (recent / A-Z /
 * attention). Topic creation now happens inside the Composer's front picker.
 *
 * The topicless pool surfaces here too, as an always-shown Uncategorized row
 * pinned at the bottom (exempt from both filters) that opens the synthetic
 * UNFILED_ID pseudo-thread — the old Unfiled card's replacement.
 *
 * The selected front filter is lifted to ResearchPage.tsx. The sort mode is
 * local, persisted to localStorage.
 */

import { useMemo, useState } from 'react';
import { Card } from './Card';
import { orderedTopics, plural, sortTopics, topicStats, unfiledEntries, type ThreadSortMode } from './helpers';
import { useResearchCtx } from './ResearchContext';
import { useFronts } from './useResearchData';
import { FRONT_EMOJI, type Front } from '../fronts/useFronts';
import { UNFILED_ID, type Entry, type Topic } from './types';
import styles from './ResearchPage.module.css';

const SORT_KEY = 'rsrch-thread-sort';
const SORT_MODES: { mode: ThreadSortMode; label: string }[] = [
  { mode: 'recent', label: 'Recent' },
  { mode: 'name', label: 'A–Z' },
  { mode: 'attention', label: 'Attention' },
];

function readSortMode(): ThreadSortMode {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw === 'recent' || raw === 'name' || raw === 'attention') return raw;
  } catch {
    // storage blocked — fall through to the default
  }
  return 'recent';
}

function writeSortMode(mode: ThreadSortMode): void {
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch {
    // storage full/blocked — sort choice just won't persist
  }
}

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

function ThreadLine({
  topic,
  latest,
  fronts,
  onFilterFront,
}: {
  topic: Topic;
  latest: Entry | undefined;
  fronts: Front[];
  onFilterFront: (id: string) => void;
}) {
  const { state, actions } = useResearchCtx();
  const stats = topicStats(topic.id, state.entries);
  const updated = ago(latest?.created);
  const fronts_ = topicFronts(topic);
  const openThread = () => actions.openThread(topic.id);

  function filterFront(fid: string, e: React.MouseEvent) {
    e.stopPropagation();
    onFilterFront(fid);
  }

  return (
    <div
      className={styles.threadLine}
      role="button"
      tabIndex={0}
      onClick={openThread}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThread();
        }
      }}
    >
      <span className={styles.threadLineTop}>
        <span className={styles.threadLineName}>{topic.name}</span>
        <span className={styles.dirChevron}>&#8250;</span>
      </span>
      <span className={styles.threadLineMeta}>
        {fronts_.length ? (
          fronts_.map((fid) => {
            const f = fronts.find((x) => x.id === fid);
            return (
              <button
                type="button"
                key={fid}
                className={styles.threadFrontChip}
                onClick={(e) => filterFront(fid, e)}
              >
                {FRONT_EMOJI[fid] ?? '🏷️'} {f ? f.name : fid}
              </button>
            );
          })
        ) : (
          <button
            type="button"
            className={`${styles.threadFrontChip} ${styles.threadFrontChipMuted}`}
            onClick={(e) => filterFront('unassigned', e)}
          >
            🏷️ Unassigned
          </button>
        )}
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
    </div>
  );
}

/** Pinned bottom row for topicless entries — same threadLine shape as a real
 * thread, opening the synthetic Uncategorized pseudo-thread. Always shown
 * while unfiled entries exist, ignoring both the name and front filters. */
function UnfiledRow({ entries }: { entries: Entry[] }) {
  const { actions } = useResearchCtx();
  const latest = entries[0];
  const openUnfiled = () => actions.openThread(UNFILED_ID);

  return (
    <div
      className={`${styles.threadLine} ${styles.threadLineMuted}`}
      role="button"
      tabIndex={0}
      onClick={openUnfiled}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openUnfiled();
        }
      }}
    >
      <span className={styles.threadLineTop}>
        <span className={styles.threadLineName}>Uncategorized</span>
        <span className={styles.dirChevron}>&#8250;</span>
      </span>
      <span className={styles.threadLineMeta}>
        <span className={`${styles.threadFrontChip} ${styles.threadFrontChipMuted}`}>🏷️ Unfiled</span>
        <span className={styles.threadLineCount}>
          {entries.length} {plural(entries.length, 'entry', 'entries')}
        </span>
      </span>
      {latest ? (
        <span className={styles.threadLineRecap}>
          {latest.author === 'llm' ? 'Claude: ' : ''}
          {latest.text}
        </span>
      ) : null}
    </div>
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
  const [sortMode, setSortMode] = useState<ThreadSortMode>(() => readSortMode());
  const [nameFilter, setNameFilter] = useState('');

  function changeSort(mode: ThreadSortMode) {
    setSortMode(mode);
    writeSortMode(mode);
  }

  const topics = orderedTopics(state.topics, state.entries);
  const latest = useMemo(() => latestByTopic(state.entries), [state.entries]);
  const unfiled = useMemo(() => unfiledEntries(state.entries), [state.entries]);

  const usedFrontIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of topics) for (const fid of topicFronts(t)) ids.add(fid);
    return ids;
  }, [topics]);
  const hasUnassigned = useMemo(() => topics.some((t) => topicFronts(t).length === 0), [topics]);
  const filterPills = fronts.filter((f) => usedFrontIds.has(f.id));

  const needle = nameFilter.trim().toLowerCase();
  const filtered = topics.filter((t) => {
    const passesFront =
      frontFilter === 'all' ||
      (frontFilter === 'unassigned' ? topicFronts(t).length === 0 : topicFronts(t).includes(frontFilter));
    if (!passesFront) return false;
    return !needle || t.name.toLowerCase().includes(needle);
  });
  const sorted = sortTopics(filtered, state.entries, sortMode);

  const line = (t: Topic) => (
    <ThreadLine key={t.id} topic={t} latest={latest[t.id]} fronts={fronts} onFilterFront={onFrontFilterChange} />
  );

  return (
    <Card cardId="research-threads" defaultOpen title="Threads" count={topics.length}>
      <input
        type="text"
        className={styles.threadFilterInput}
        placeholder="filter threads…"
        value={nameFilter}
        onChange={(e) => setNameFilter(e.target.value)}
      />
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
      <div className={styles.composerChips}>
        {SORT_MODES.map(({ mode, label }) => (
          <button
            type="button"
            key={mode}
            className={`${styles.chip} ${sortMode === mode ? styles.chipActive : ''}`}
            onClick={() => changeSort(mode)}
          >
            {label}
          </button>
        ))}
      </div>
      {filtered.length || unfiled.length ? (
        <div className={styles.threadStack}>
          {sorted.map(line)}
          {unfiled.length ? <UnfiledRow entries={unfiled} /> : null}
        </div>
      ) : (
        <div className={styles.emptyNote}>
          {topics.length ? 'No threads match this filter.' : 'No threads yet.'}
        </div>
      )}
    </Card>
  );
}
