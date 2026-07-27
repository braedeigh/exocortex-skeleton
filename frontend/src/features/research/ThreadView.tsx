/**
 * ThreadView.tsx — one thread as a observatory: an open chronological flow
 * read top-to-bottom, not a stack of collapsed cards. Top-level entries
 * render oldest-first (threadStructure hands back newest-first for the
 * directory's recap line, so this view reverses a copy); replies under a
 * parent stay chronological underneath, nested recursively — the whole
 * thread reads like a chat log. Nothing collapses and nothing persists
 * open/closed state; opening a thread scrolls straight to the newest entry
 * at the bottom, where the thread-scoped composer lives so replying is a
 * straight shot from what you just read.
 */

import { useEffect, useRef, useState } from 'react';
import { Composer } from './Composer';
import { EntryRow } from './EntryRow';
import {
  NEXT_TOPIC_STATUS,
  edgeFor,
  plural,
  reviewedSince,
  sessionsForTopic,
  threadStructure,
  unfiledStructure,
} from './helpers';
import { DistillButton } from './Pills';
import { useResearchCtx } from './ResearchContext';
import { SessionsCard } from './SessionsCard';
import { useFronts } from './useResearchData';
import { FRONT_EMOJI } from '../fronts/useFronts';
import { UNFILED_ID, type Entry, type Topic } from './types';
import styles from './ResearchPage.module.css';

/** One entry, always open, with its replies nested underneath (recursively,
 * reply-of-reply). No collapse, no open-state persistence — the observatory
 * flow shows everything. */
function ThreadEntryBlock({
  entry,
  repliesOf,
  editing,
}: {
  entry: Entry;
  repliesOf: Record<string, Entry[]>;
  editing: boolean;
}) {
  const kids = repliesOf[entry.id] ?? [];
  return (
    <div className={styles.block}>
      <EntryRow entry={entry} editing={editing} />
      {kids.length ? (
        <div className={styles.blockKids}>
          {kids.map((k) => (
            <ThreadEntryBlock key={k.id} entry={k} repliesOf={repliesOf} editing={editing} />
          ))}
        </div>
      ) : null}
    </div>
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
  const isUnfiled = topic.id === UNFILED_ID;
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];
  const topicFronts = topic.fronts ?? [];

  const { entries, topLevel, repliesOf } = isUnfiled
    ? unfiledStructure(state.entries)
    : threadStructure(state.entries, topic.id);
  const sessions = sessionsForTopic(state.sessions, topic.id);

  // threadStructure/unfiledStructure hand back topLevel newest-first (that
  // ordering suits the directory's recap line); the observatory reads
  // oldest-to-newest top-to-bottom, so reverse a copy here rather than touch
  // the shared helper (its own tests pin the newest-first contract).
  const topLevelOldestFirst = [...topLevel].reverse();
  const lastTopLevelId = topLevelOldestFirst.length
    ? topLevelOldestFirst[topLevelOldestFirst.length - 1].id
    : null;

  // Auto-scroll to the newest (bottom) entry once per thread visit — not on
  // every 5s poll re-render while a session is running, hence the ref flag
  // rather than relying on effect deps alone.
  const bodyEndRef = useRef<HTMLDivElement | null>(null);
  const scrolledTopicRef = useRef<string | null>(null);
  const hasEntries = entries.length > 0;

  useEffect(() => {
    if (!hasEntries) return;
    if (scrolledTopicRef.current === topic.id) return;
    scrolledTopicRef.current = topic.id;
    bodyEndRef.current?.scrollIntoView({ block: 'end' });
  }, [topic.id, hasEntries]);

  const body = (
    <div className={styles.threadBody}>
      {topLevelOldestFirst.length ? (
        topLevelOldestFirst.map((e) => (
          <div key={e.id} ref={e.id === lastTopLevelId ? bodyEndRef : undefined}>
            <ThreadEntryBlock entry={e} repliesOf={repliesOf} editing={editing} />
          </div>
        ))
      ) : (
        <div className={styles.emptyNote}>No entries yet &mdash; start below.</div>
      )}
    </div>
  );

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
          {!isUnfiled && topicFronts.length ? (
            <div className={styles.chipRow}>
              {topicFronts.map((fid) => {
                const f = fronts.find((x) => x.id === fid);
                return (
                  <span key={fid} className={styles.threadFrontChip}>
                    {FRONT_EMOJI[fid] ?? '🏷️'} {f ? f.name : fid}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
        {!isUnfiled ? <DistillButton topic={topic} /> : null}
        {!isUnfiled ? (
          <button type="button" className={styles.cardEditBtn} onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        ) : null}
      </div>

      {!isUnfiled && editing ? <TopicEditor topic={topic} /> : null}

      {!isUnfiled ? <EdgeCard topic={topic} /> : null}

      {isUnfiled && entries.length ? (
        <button type="button" className={styles.cardEditBtn} onClick={() => actions.fileUnfiled()}>
          &#10024; File these
        </button>
      ) : null}

      {body}

      {!isUnfiled ? <SessionsCard sessions={sessions} /> : null}

      {isUnfiled ? (
        <Composer />
      ) : (
        <Composer presetTopic={topic.id} hideTopics addLabel="Add to thread" placeholder="Add to this thread…" inThread />
      )}
    </>
  );
}
