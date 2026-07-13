/**
 * ThreadView.tsx — one thread as a chat: her entries + nested llm replies.
 * Top-level entries newest-first (posting lands at the top); replies under a
 * parent stay chronological so a chain reads top-to-bottom. The composer
 * sits above the rows, preset to this thread. Each top-level block collapses
 * independently (same localStorage open-memory as the top cards, keyed per
 * entry id), open by default.
 */

import { useState, type SyntheticEvent } from 'react';
import { readCardOpen, writeCardOpen } from './cardState';
import { Composer } from './Composer';
import { EntryRow } from './EntryRow';
import {
  KIND_LABEL,
  NEXT_TOPIC_STATUS,
  edgeFor,
  flaggedQueue,
  plural,
  reviewedSince,
  sessionsForTopic,
  threadStructure,
  truncate,
} from './helpers';
import { DistillButton } from './Pills';
import { useResearchCtx } from './ResearchContext';
import { SendStrip } from './SendStrip';
import { SessionsCard } from './SessionsCard';
import { useFronts } from './useResearchData';
import type { Entry, Topic } from './types';
import styles from './ResearchPage.module.css';

function ThreadBlock({
  entry,
  repliesOf,
  editing,
}: {
  entry: Entry;
  repliesOf: Record<string, Entry[]>;
  editing: boolean;
}) {
  const kids = repliesOf[entry.id] ?? [];
  const cardId = `research-block-${entry.id}`;
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? readCardOpen(cardId, true);

  function onToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    const next = e.currentTarget.open;
    if (next === open) return;
    setOverride(next);
    writeCardOpen(cardId, next);
  }

  const badgeLabel = entry.author === 'llm' ? '✨ claude' : (KIND_LABEL[entry.kind] ?? entry.kind);
  const snippet = truncate((entry.text ?? '').replace(/\s+/g, ' '), 90);

  return (
    <details className={styles.block} open={open} onToggle={onToggle} data-card={cardId}>
      <summary className={styles.blockSummary}>
        <span className={styles.arrow}>&#9654;</span>
        <b className={styles.blockBadge}>{badgeLabel}</b>
        <span className={styles.blockSnippet}>{snippet}</span>
        {kids.length ? (
          <span className={styles.cardCount}>
            {kids.length} {plural(kids.length, 'reply', 'replies')}
          </span>
        ) : null}
      </summary>
      <EntryRow entry={entry} editing={editing} />
      {kids.length ? (
        <div className={styles.blockKids}>
          {kids.map((k) => (
            <ThreadBlock key={k.id} entry={k} repliesOf={repliesOf} editing={editing} />
          ))}
        </div>
      ) : null}
    </details>
  );
}

function TopicEditor({ topic }: { topic: Topic }) {
  const { mutations, actions, requestConfirm, confirmKey } = useResearchCtx();
  const [name, setName] = useState(topic.name);
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];
  const topicFronts = topic.fronts ?? [];
  const deleteKey = `topic:${topic.id}`;
  const armed = confirmKey === deleteKey;

  function commitName() {
    const next = name.trim();
    if (!next || next === topic.name) return;
    mutations.editTopic.mutate({ id: topic.id, name: next });
  }

  function toggleFront(id: string) {
    const next = topicFronts.includes(id) ? topicFronts.filter((f) => f !== id) : [...topicFronts, id];
    mutations.editTopic.mutate({ id: topic.id, fronts: next });
  }

  return (
    <div className={styles.topicEditor}>
      <div className={styles.topicEditorRow}>
        <input
          type="text"
          className={styles.topicNameInput}
          value={name}
          placeholder="Topic name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
          }}
        />
        <button
          type="button"
          className={styles.outlineBtn}
          onClick={() =>
            mutations.editTopic.mutate({ id: topic.id, status: NEXT_TOPIC_STATUS[topic.status] ?? 'active' })
          }
        >
          Status: {topic.status} &#8594;
        </button>
        <button
          type="button"
          className={`${styles.outlineDangerBtn} ${armed ? styles.sureBtn : ''}`}
          onClick={() => {
            if (requestConfirm(deleteKey)) actions.deleteTopic(topic);
          }}
        >
          {armed ? 'Sure? Entries keep their other tags' : 'Delete topic'}
        </button>
      </div>
      {fronts.length ? (
        <div className={styles.topicEditorRow}>
          <span className={styles.contextHead}>Fronts</span>
          {fronts.map((f) => (
            <button
              type="button"
              key={f.id}
              className={`${styles.chip} ${topicFronts.includes(f.id) ? styles.chipActive : ''}`}
              onClick={() => toggleFront(f.id)}
            >
              {f.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EdgeCard({ topic }: { topic: Topic }) {
  const { state, edge, actions } = useResearchCtx();
  const note = edgeFor(edge, topic.id);
  if (!note) return null;
  const since = reviewedSince(state.entries, topic.id, note.mtime);
  return (
    <button type="button" className={styles.edgeCard} onClick={() => actions.openLibraryFile(note.file)}>
      <span className={styles.grow}>
        <span className={styles.edgeTitle}>&#10024; Edge of knowledge</span>
        <span className={styles.edgeSub}>As of {note.mtime}</span>
      </span>
      {since ? <span className={`${styles.chip} ${styles.chipStatic} ${styles.chipPurple}`}>{since} reviewed since</span> : null}
      <span className={styles.dirChevron}>&#8250;</span>
    </button>
  );
}

export function ThreadView({ topic }: { topic: Topic }) {
  const { state, actions } = useResearchCtx();
  const [editing, setEditing] = useState(false);

  const { entries, topLevel, repliesOf } = threadStructure(state.entries, topic.id);
  const flagged = flaggedQueue(entries);
  const sessions = sessionsForTopic(state.sessions, topic.id);

  return (
    <>
      <div className={styles.threadHead}>
        <button
          type="button"
          className={styles.backBtn}
          title="Back to threads"
          aria-label="Back to threads"
          onClick={() => actions.openThread('')}
        >
          &#8592;
        </button>
        <div className={styles.grow}>
          <div className={styles.threadTitle}>{topic.name}</div>
          <div className={styles.threadSub}>
            {entries.length} {plural(entries.length, 'entry', 'entries')}
          </div>
        </div>
        <DistillButton topic={topic} />
        <button type="button" className={styles.cardEditBtn} onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {editing ? <TopicEditor topic={topic} /> : null}

      <EdgeCard topic={topic} />

      <Composer presetTopic={topic.id} hideTopics addLabel="Add to thread" placeholder="Add to this thread…" inThread />

      <SendStrip flagged={flagged} scope="thread" />

      <SessionsCard sessions={sessions} />

      <div className={styles.threadBody}>
        {topLevel.length ? (
          topLevel.map((e) => <ThreadBlock key={e.id} entry={e} repliesOf={repliesOf} editing={editing} />)
        ) : (
          <div className={styles.emptyNote}>No entries yet &mdash; start above.</div>
        )}
      </div>
    </>
  );
}
