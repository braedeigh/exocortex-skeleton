/**
 * EntryRow.tsx — the shared entry row, now rendered only from ThreadView's
 * observatory flow (thread blocks + the Uncategorized pseudo-thread). Kind
 * badge (skipped for 'note', the overwhelming majority — pure noise in an
 * open flow), per-kind extras (source link/verdict/metadata/full-text
 * buttons, claim verdict cycle, question status + deep research), long text
 * clamps to ~10 lines with a "more"/"less" toggle (measured against the
 * rendered height, both for her plain text and Claude's markdown). "Small
 * until edit": the ✎ edit / ✎ highlight / ✎ highlight report utility chips
 * only render when the thread-level `editing` prop is on; reading actions
 * (reviewed/reply, send to Claude, read report, source chips, reply-line,
 * topic chips) and the two-step delete stay visible always.
 */

import { useEffect, useRef, useState } from 'react';
import { mdToHtml } from '../journal/markdown';
import { CLAIM_CYCLE, KIND_LABEL, authorsShort, entryTint, originFile, truncate } from './helpers';
import { useResearchCtx } from './ResearchContext';
import { DeepButton } from './Pills';
import type { Entry } from './types';
import styles from './ResearchPage.module.css';

const TINT_CLASS: Record<string, string> = {
  pink: styles.tintPink,
  orange: styles.tintOrange,
  purple: styles.tintPurple,
  flagged: styles.tintFlagged,
};

function MetaBox({ entry }: { entry: Entry }) {
  const { mutations } = useResearchCtx();
  const m = entry.meta ?? {};
  const title = m.title || m.doi || 'Untitled';
  const line2 = [authorsShort(m.authors), m.journal, m.published].filter(Boolean).join(' · ');
  const reviewed = !!m.reviewed;
  return (
    <div className={styles.metaBox}>
      <div className={styles.metaTitle}>
        {m.doi ? (
          <a href={`https://doi.org/${m.doi}`} target="_blank" rel="noopener noreferrer">
            {title}
          </a>
        ) : (
          title
        )}
      </div>
      {line2 ? <div className={styles.metaLine}>{line2}</div> : null}
      <div className={styles.chipRow}>
        <button
          type="button"
          className={`${styles.chip} ${reviewed ? styles.chipVerified : styles.chipInteresting}`}
          title={`Auto-fetched metadata — tap to mark ${reviewed ? 'unreviewed' : 'reviewed'}`}
          onClick={() => mutations.metaReview.mutate({ id: entry.id, reviewed: !reviewed })}
        >
          auto {reviewed ? '✓ reviewed' : '○ review'}
        </button>
        {(m.cited_by ?? null) !== null ? (
          <span className={`${styles.chip} ${styles.chipStatic}`}>cited by {Number(m.cited_by) || 0}</span>
        ) : null}
        {m.pdf_url ? (
          <a className={styles.chip} href={m.pdf_url} target="_blank" rel="noopener noreferrer">
            free PDF &#8599;
          </a>
        ) : null}
      </div>
      {m.abstract ? (
        <details className={styles.metaAbstract}>
          <summary>Abstract</summary>
          <div className={styles.metaAbstractBody}>{m.abstract}</div>
        </details>
      ) : null}
    </div>
  );
}

export function EntryRow({ entry: e, editing }: { entry: Entry; editing: boolean }) {
  const { state, byId, docTexts, fetchingText, annotatingMeta, mutations, actions, requestConfirm, confirmKey } =
    useResearchCtx();
  const entries = state.entries;
  const isLlm = e.author === 'llm';

  const [editingText, setEditingText] = useState(false);
  const [draft, setDraft] = useState('');

  // Long-text clamp: the clamp class applies whenever the entry isn't
  // expanded (overflow can only be MEASURED while the element is clamped —
  // an unclamped element never overflows, so gating the class on the
  // measurement would deadlock at "never clamped"). Short text under the
  // clamp height is unaffected by the class; the "more" toggle only shows
  // when the clamped element actually overflows. Re-measure whenever the
  // text changes (an edit can push it over, or under, the threshold).
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [textExpanded, setTextExpanded] = useState(false);
  const [textOverflowing, setTextOverflowing] = useState(false);

  useEffect(() => {
    setTextExpanded(false);
  }, [e.text]);

  useEffect(() => {
    if (textExpanded) return;
    const el = textRef.current;
    setTextOverflowing(!!el && el.scrollHeight - el.clientHeight > 1);
  }, [e.text, textExpanded]);

  function startTextEdit() {
    setDraft(e.text);
    setEditingText(true);
  }

  function saveTextEdit() {
    const text = draft.trim();
    if (text && text !== e.text) mutations.editEntry.mutate({ id: e.id, text });
    setEditingText(false);
  }

  // --- per-kind extras ---
  let extra: React.ReactNode = null;
  if (e.kind === 'source') {
    const verified = e.verdict === 'verified';
    const doc = `entry:${e.id}`;
    const busy = annotatingMeta.has(e.id);
    const fetching = fetchingText.has(e.id);
    extra = (
      <>
        <div className={styles.chipRow}>
          {e.url ? (
            <a className={styles.srcLink} href={e.url} target="_blank" rel="noopener noreferrer">
              {e.url} &#8599;
            </a>
          ) : null}
          <button
            type="button"
            className={`${styles.chip} ${verified ? styles.chipVerified : ''}`}
            onClick={() => mutations.editEntry.mutate({ id: e.id, verdict: verified ? '' : 'verified' })}
          >
            {verified ? '✓ verified' : '○ unverified'}
          </button>
          {!e.meta || editing ? (
            <button
              type="button"
              className={styles.chip}
              disabled={busy}
              onClick={() => actions.annotateSourceMeta(e.id)}
            >
              {busy ? '✨ fetching…' : e.meta ? '↻ re-annotate' : '✨ annotate'}
            </button>
          ) : null}
          {docTexts.has(doc) ? (
            <button type="button" className={styles.chip} onClick={() => actions.openAnnotator(doc, e.text.slice(0, 60))}>
              &#128214; read
            </button>
          ) : e.url ? (
            <button type="button" className={styles.chip} disabled={fetching} onClick={() => actions.fetchText(e.id)}>
              {fetching ? '⌛ fetching…' : '⬇ get text'}
            </button>
          ) : null}
        </div>
        {e.meta ? <MetaBox entry={e} /> : null}
      </>
    );
  } else if (e.kind === 'claim') {
    const verdictClass =
      e.verdict === 'real'
        ? styles.chipVerified
        : e.verdict === 'shaky'
          ? styles.chipShaky
          : e.verdict === 'interesting'
            ? styles.chipInteresting
            : '';
    extra = (
      <div className={styles.chipRow}>
        <button
          type="button"
          className={`${styles.chip} ${verdictClass}`}
          onClick={() => mutations.editEntry.mutate({ id: e.id, verdict: CLAIM_CYCLE[e.verdict ?? ''] ?? 'real' })}
        >
          {e.verdict || '—'}
        </button>
      </div>
    );
  } else if (e.kind === 'question') {
    const answered = e.status === 'answered';
    const answers = entries.filter((x) => x.reply_to === e.id);
    extra = (
      <div className={styles.chipRow}>
        <button
          type="button"
          className={`${styles.chip} ${answered ? styles.chipAnswered : ''}`}
          onClick={() => mutations.editEntry.mutate({ id: e.id, status: answered ? 'open' : 'answered' })}
        >
          {answered ? 'answered' : 'open'}
        </button>
        {answers.length ? (
          <span className={`${styles.chip} ${styles.chipStatic}`}>
            &#8618; {answers.length} answer{answers.length === 1 ? '' : 's'}
          </span>
        ) : null}
        {e.status === 'open' && !isLlm ? <DeepButton entry={e} /> : null}
      </div>
    );
  }

  // An entry that answers a question wears the link — the walkable web.
  const repliedTo = e.reply_to ? entries.find((x) => x.id === e.reply_to) : undefined;
  const origin = originFile(e);

  // Read mode: the entry's own tags. Edit mode: every topic becomes a toggle
  // chip — the manual door for the Unfiled backstop.
  const topicChips = editing
    ? state.topics.map((t) => {
        const has = (e.topics ?? []).includes(t.id);
        return (
          <button
            type="button"
            key={t.id}
            className={`${styles.chip} ${has ? styles.chipActive : ''}`}
            onClick={() => {
              const cur = new Set(e.topics ?? []);
              if (cur.has(t.id)) cur.delete(t.id);
              else cur.add(t.id);
              mutations.editEntry.mutate({ id: e.id, topics: Array.from(cur) });
            }}
          >
            {t.name}
          </button>
        );
      })
    : (e.topics ?? []).flatMap((tid) =>
        byId[tid]
          ? [
              <span key={tid} className={`${styles.chip} ${styles.chipStatic}`}>
                {byId[tid].name}
              </span>,
            ]
          : [],
      );

  const tint = entryTint(e, entries);
  const confirmDeleteKey = `entry:${e.id}`;
  const armed = confirmKey === confirmDeleteKey;

  return (
    <div className={`${styles.entryRow} ${tint ? TINT_CLASS[tint] : ''}`}>
      <div className={styles.entryMain}>
        <div className={styles.entryHead}>
          {isLlm ? (
            <span className={`${styles.kind} ${styles.kindLlm}`}>&#10024; claude</span>
          ) : e.kind !== 'note' ? (
            <span
              className={`${styles.kind} ${
                e.kind === 'source' ? styles.kindSource : e.kind === 'claim' ? styles.kindClaim : styles.kindQuestion
              }`}
            >
              {KIND_LABEL[e.kind] ?? e.kind}
            </span>
          ) : null}
          {/* Claude's replies may use markdown; her own text stays plain. */}
          {isLlm ? (
            <span
              ref={textRef}
              className={`${styles.entryText} ${!textExpanded ? styles.entryTextClamped : ''}`}
              dangerouslySetInnerHTML={{ __html: mdToHtml(e.text) }}
            />
          ) : (
            <span
              ref={textRef}
              className={`${styles.entryText} ${!textExpanded ? styles.entryTextClamped : ''}`}
            >
              {e.text}
            </span>
          )}
        </div>

        {textOverflowing ? (
          <button type="button" className={styles.moreBtn} onClick={() => setTextExpanded((v) => !v)}>
            {textExpanded ? '↑ less' : '↓ more'}
          </button>
        ) : null}

        {extra}

        {editingText ? (
          <div className={styles.inlineEdit}>
            <textarea
              className={styles.inlineEditArea}
              rows={3}
              value={draft}
              autoFocus
              onChange={(ev) => setDraft(ev.target.value)}
            />
            <button type="button" className={styles.primaryBtn} onClick={saveTextEdit}>
              Save
            </button>
            <button type="button" className={styles.outlineBtn} onClick={() => setEditingText(false)}>
              Cancel
            </button>
          </div>
        ) : null}

        <div className={styles.chipRow}>
          {isLlm ? (
            <>
              <button
                type="button"
                className={`${styles.chip} ${e.reviewed ? styles.chipVerified : styles.chipInteresting}`}
                onClick={() => mutations.reviewEntry.mutate({ id: e.id, reviewed: !e.reviewed })}
              >
                {e.reviewed ? '✓ reviewed' : '○ mark reviewed'}
              </button>
              <button type="button" className={styles.chip} onClick={() => actions.startAnswer(e.id)}>
                &#8618; reply
              </button>
            </>
          ) : (
            <button type="button" className={styles.chip} onClick={() => mutations.send.mutate([e.id])}>
              &#10148; send to Claude
            </button>
          )}
          {editing ? (
            <button type="button" className={styles.chip} onClick={startTextEdit}>
              &#9998; edit
            </button>
          ) : null}
          {e.file ? (
            <>
              {/* Deep-research replies point at the write-up they came from. */}
              <button type="button" className={styles.chip} onClick={() => actions.openLibraryFile(e.file!)}>
                &#128214; Read report
              </button>
              {editing ? (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => actions.openAnnotator(`note:${e.file}`, 'report')}
                >
                  &#9998; highlight report
                </button>
              ) : null}
            </>
          ) : editing && e.kind !== 'source' && (e.text ?? '').length > 40 ? (
            <button
              type="button"
              className={styles.chip}
              onClick={() => actions.openAnnotator(`entry:${e.id}`, KIND_LABEL[e.kind] ?? e.kind)}
            >
              &#9998; highlight
            </button>
          ) : null}
        </div>

        {repliedTo || origin ? (
          <div className={styles.replyLine}>
            {repliedTo ? (
              <span>
                &#8618; answers: <i>{truncate(repliedTo.text, 80)}</i>
              </span>
            ) : null}
            {origin ? (
              <button type="button" className={styles.linkBtn} onClick={() => actions.openLibraryFile(origin)}>
                from {origin} &#8599;
              </button>
            ) : null}
          </div>
        ) : null}

        {topicChips.length ? <div className={styles.tagRow}>{topicChips}</div> : null}
      </div>

      <button
        type="button"
        className={`${styles.delBtn} ${armed ? styles.delBtnSure : ''}`}
        title="Delete"
        aria-label={armed ? 'Confirm delete entry' : 'Delete entry'}
        onClick={() => {
          if (requestConfirm(confirmDeleteKey)) actions.deleteEntry(e);
        }}
      >
        {armed ? 'Sure?' : <>&times;</>}
      </button>
    </div>
  );
}
