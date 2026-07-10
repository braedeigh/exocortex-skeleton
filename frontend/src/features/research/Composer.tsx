/**
 * Composer.tsx — the quick-capture composer (note/source/claim/question
 * kinds, topic chips, answering pill, "re:" quote pill, trimmable context
 * chain, and the "Research this" shortcut for quoted follow-up questions).
 * State lives on the page (one composer per view) so the annotator and the
 * open-questions card can aim it.
 */

import { RSRCH_KINDS, truncate } from './helpers';
import { useResearchCtx } from './ResearchContext';
import type { EntryKind } from './types';
import styles from './ResearchPage.module.css';

/** DOM id of the composer textarea — same as the legacy page's, so
 * "Answer…" / follow-up flows can scroll + focus it (one composer per view). */
export const COMPOSER_TEXT_ID = 'rsrch-add-text';

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
  placeholder = 'Capture a note, source, claim, or question…',
  inThread,
}: ComposerProps) {
  const { composer: st, setComposer, state, actions } = useResearchCtx();
  const topics = state.topics;

  const setKind = (kind: EntryKind) => setComposer((c) => ({ ...c, kind }));
  const toggleTopic = (id: string) =>
    setComposer((c) => {
      const next = new Set(c.topics);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...c, topics: next };
    });

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

      {st.kind === 'source' ? (
        <input
          type="text"
          className={styles.composerUrl}
          placeholder="URL"
          value={st.url}
          onChange={(e) => setComposer((c) => ({ ...c, url: e.target.value }))}
        />
      ) : null}

      <div className={styles.composerChips}>
        {RSRCH_KINDS.map(([k, label]) => (
          <button
            type="button"
            key={k}
            className={`${styles.chip} ${st.kind === k ? styles.chipActive : ''}`}
            onClick={() => setKind(k as EntryKind)}
          >
            {label}
          </button>
        ))}
      </div>

      {!hideTopics ? (
        <div className={styles.composerChips}>
          {topics.length ? (
            topics.map((t) => (
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
            <span className={styles.composerHint}>No topics yet &mdash; add one at the bottom of the page.</span>
          )}
        </div>
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
