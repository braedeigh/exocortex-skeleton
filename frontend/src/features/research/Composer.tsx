/**
 * Composer.tsx — the quick-capture composer. Capture text, then sort it into
 * a FRONT: picking a front reveals that front's topics (file into one or
 * several) plus an inline new-topic row that creates a topic pre-tagged with
 * the front. "Uncategorized" is the catch-all — frontless topics live there,
 * and adding with no topic at all lands the entry in the Unfiled backstop.
 *
 * The note/source/claim/question kind split is retired from the UI (entries
 * default to 'note'); reply flows still set kind programmatically (answering
 * pill, "re:" quote pill, trimmable context chain, "Research this" for quoted
 * follow-up questions). State lives on the page (one composer per view) so
 * the annotator and the open-questions card can aim it.
 */

import { useMemo, useState } from 'react';
import { truncate } from './helpers';
import { useResearchCtx } from './ResearchContext';
import { useFronts } from './useResearchData';
import { FRONT_EMOJI } from '../fronts/useFronts';
import styles from './ResearchPage.module.css';

/** DOM id of the composer textarea — same as the legacy page's, so
 * "Answer…" / follow-up flows can scroll + focus it (one composer per view). */
export const COMPOSER_TEXT_ID = 'rsrch-add-text';

/** Pseudo-front for topics that carry no front tag (and topicless adds). */
const UNCATEGORIZED = '__uncategorized__';

export interface ComposerProps {
  presetTopic?: string;
  hideTopics?: boolean;
  addLabel?: string;
  placeholder?: string;
  inThread?: boolean;
}

export function Composer({
  presetTopic,
  hideTopics,
  addLabel = 'Add',
  placeholder = 'Capture something, then sort it into a front…',
  inThread,
}: ComposerProps) {
  const { composer: st, setComposer, state, actions, mutations, push } = useResearchCtx();
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];

  // Which front is open in the picker. Survives an add on purpose — filing
  // several captures into the same front in a row shouldn't re-pick it.
  const [front, setFront] = useState<string | null>(null);
  const [newTopicName, setNewTopicName] = useState('');

  const frontTopics = useMemo(() => {
    if (!front) return [];
    if (front === UNCATEGORIZED) return state.topics.filter((t) => !(t.fronts && t.fronts.length));
    return state.topics.filter((t) => (t.fronts ?? []).includes(front));
  }, [front, state.topics]);

  // Selected topics that the open front doesn't show (reply-inherited, or
  // picked under another front) — keep them visible so nothing files blind.
  const hiddenSelected = useMemo(() => {
    const visible = new Set(frontTopics.map((t) => t.id));
    return state.topics.filter((t) => st.topics.has(t.id) && !visible.has(t.id));
  }, [frontTopics, state.topics, st.topics]);

  const toggleTopic = (id: string) =>
    setComposer((c) => {
      const next = new Set(c.topics);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...c, topics: next };
    });

  function createTopic() {
    const name = newTopicName.trim();
    if (!name) {
      push('Name the topic first.');
      return;
    }
    const before = new Set(state.topics.map((t) => t.id));
    mutations.addTopic.mutate(
      { name, fronts: front && front !== UNCATEGORIZED ? [front] : undefined },
      {
        onSuccess: (blob) => {
          setNewTopicName('');
          // The new topic is whichever id the returned blob has that we didn't.
          const created = (blob.topics ?? []).find((t) => !before.has(t.id));
          if (created) toggleTopic(created.id);
        },
      },
    );
  }

  return (
    <div className={`${styles.composer} ${inThread ? styles.composerInThread : ''}`}>
      {st.replyTo && !st.reQuote ? (
        <div className={styles.replyPill}>
          <span className={styles.pillText}>
            &#8618; answering: <i>{st.replyTo.text}</i>
          </span>
          <button
            type="button"
            className={styles.pillClose}
            title="Cancel answering"
            aria-label="Cancel answering"
            onClick={actions.cancelAnswer}
          >
            &times;
          </button>
        </div>
      ) : null}

      {st.reQuote ? (
        <div className={styles.reQuotePill}>
          <span className={styles.pillText}>
            <i>
              re: &ldquo;{truncate(st.reQuote, 120)}&rdquo;
            </i>
          </span>
          <button
            type="button"
            className={styles.pillClose}
            title="Clear point context"
            aria-label="Clear point context"
            onClick={actions.clearReQuote}
          >
            &times;
          </button>
        </div>
      ) : null}

      <textarea
        id={COMPOSER_TEXT_ID}
        className={styles.composerText}
        rows={2}
        placeholder={placeholder}
        value={st.text}
        onChange={(e) => setComposer((c) => ({ ...c, text: e.target.value }))}
      />

      {!hideTopics ? (
        <>
          <div className={styles.composerChips}>
            {fronts.map((f) => (
              <button
                type="button"
                key={f.id}
                className={`${styles.chip} ${front === f.id ? styles.chipActive : ''}`}
                onClick={() => setFront((cur) => (cur === f.id ? null : f.id))}
              >
                {FRONT_EMOJI[f.id] ? `${FRONT_EMOJI[f.id]} ` : ''}
                {f.name}
              </button>
            ))}
            <button
              type="button"
              className={`${styles.chip} ${front === UNCATEGORIZED ? styles.chipActive : ''}`}
              onClick={() => setFront((cur) => (cur === UNCATEGORIZED ? null : UNCATEGORIZED))}
            >
              &#127991;&#65039; Uncategorized
            </button>
          </div>

          {front ? (
            <>
              <div className={styles.composerChips}>
                {frontTopics.length ? (
                  frontTopics.map((t) => (
                    <button
                      type="button"
                      key={t.id}
                      className={`${styles.chip} ${st.topics.has(t.id) ? styles.chipActive : ''}`}
                      onClick={() => toggleTopic(t.id)}
                    >
                      {t.name}
                    </button>
                  ))
                ) : (
                  <span className={styles.composerHint}>
                    {front === UNCATEGORIZED
                      ? 'No frontless topics — add without one and it lands in Unfiled.'
                      : 'No topics on this front yet — start one below.'}
                  </span>
                )}
              </div>
              <div className={styles.newTopicRow}>
                <input
                  type="text"
                  className={styles.newTopicInput}
                  placeholder="New topic in this front"
                  value={newTopicName}
                  onChange={(e) => setNewTopicName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createTopic();
                  }}
                />
                <button type="button" className={styles.primaryBtn} onClick={createTopic}>
                  New topic
                </button>
              </div>
            </>
          ) : null}

          {hiddenSelected.length ? (
            <div className={styles.composerChips}>
              <span className={styles.composerHint}>also filing to:</span>
              {hiddenSelected.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`${styles.chip} ${styles.chipActive}`}
                  title="Tap to remove"
                  onClick={() => toggleTopic(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {st.contextChain && st.contextChain.length ? (
        <div className={styles.contextBox}>
          <div className={styles.contextHead}>context (deselect to trim):</div>
          {st.contextChain.map((c) => (
            <label key={c.id} className={styles.contextRow}>
              <input
                type="checkbox"
                className={styles.contextCheckbox}
                checked={c.checked}
                onChange={() => actions.toggleContext(c.id)}
              />
              <span className={styles.contextKind}>{c.kind}</span>
              <span className={styles.contextSnippet}>
                {c.snippet}
                {c.snippet.length >= 90 ? '…' : ''}
              </span>
              {c.file ? (
                <span className={styles.contextFile} title="has report file">
                  &#128196;
                </span>
              ) : null}
            </label>
          ))}
        </div>
      ) : null}

      <div className={styles.composerActions}>
        <button type="button" className={styles.tealBtn} onClick={() => actions.addEntry(presetTopic)}>
          {addLabel}
        </button>
        {st.reQuote && st.kind === 'question' ? (
          <button type="button" className={styles.outlineAccentBtn} onClick={() => actions.addAndResearch(presetTopic)}>
            &#128300; Research this
          </button>
        ) : null}
      </div>
    </div>
  );
}
