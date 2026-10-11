/**
 * Annotator.tsx — labrador's char-anchored highlights, generic over docs
 * (entry:<id> extracted source text, note:<file> research markdown). An
 * annotation = {selector: {exact, char_start, char_end}, content: {kind,
 * note, source}, needs_review}. Highlights render amber until reviewed
 * (green); the server re-resolves every selector against the live doc text
 * (verified/relocated/lost) on each GET, and the pure anchor.ts math turns
 * them into non-overlapping marks — drawn by AnnotatedText.tsx, which also
 * turns a text selection back into offsets. Select text → floating
 * "✎ Annotate" pop → note form (the old prompt()). Each annotation can be
 * sent to research one-off or batched (regular/deep per row), or turned into
 * a composer follow-up carrying the exact quote + reply-chain context.
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { AnnotatedText, scrollToMark } from './AnnotatedText';
import { contextChain, resolveDocOwner, truncate } from './helpers';
import { useResearchCtx } from './ResearchContext';
import { useAnnotationMutations, useAnnotations, useDocText } from './useResearchData';
import type { Annotation } from './types';
import readerStyles from './Reader.module.css';
import pageStyles from './ResearchPage.module.css';
import styles from './Annotator.module.css';

export interface AnnotatorProps {
  doc: string;
  fallbackTitle: string;
  onClose: () => void;
  /** Open with this highlight already active and scrolled into view. */
  initialAnnotationId?: string;
}

interface PendingSelection {
  start: number;
  end: number;
}

type NoteForm =
  | { mode: 'create'; start: number; end: number; quote: string }
  | { mode: 'edit'; id: string; quote: string };

export function Annotator({ doc, fallbackTitle, onClose, initialAnnotationId }: AnnotatorProps) {
  const { state, push, mutations, actions, requestConfirm, confirmKey } = useResearchCtx();

  const textQuery = useDocText(doc);
  const annsQuery = useAnnotations(doc);
  const annMutations = useAnnotationMutations(doc, push);

  const text = textQuery.data?.text ?? '';
  const title = textQuery.data?.title || fallbackTitle || doc;
  const items = annsQuery.data ?? [];

  const [activeId, setActiveId] = useState<string | null>(initialAnnotationId ?? null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modes, setModes] = useState<Record<string, string>>({});
  const [batchMsg, setBatchMsg] = useState('');
  const [pop, setPop] = useState<{ left: number; top: number } | null>(null);
  const [noteForm, setNoteForm] = useState<NoteForm | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const textRef = useRef<HTMLDivElement>(null);
  const pending = useRef<PendingSelection | null>(null);

  // The doc has no fetched text — bail out with the old alert's message.
  const textError = textQuery.error;
  useEffect(() => {
    if (!textError) return;
    push(
      textError instanceof ApiError && textError.status === 404
        ? 'No text fetched for this document yet.'
        : 'Could not load the document text.',
    );
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textError]);

  // Float the "Annotate" pop above a fresh selection.
  // AnnotatedText hands over the character offsets and the selection's
  // rectangle; the pop is clamped inside the viewport.
  function onSelectRange(start: number, end: number, _exact: string, rect: DOMRect) {
    pending.current = { start, end };
    setPop({
      left: Math.max(8, Math.min(window.innerWidth - 150, rect.left + rect.width / 2 - 65)),
      top: Math.max(8, rect.top - 48),
    });
  }

  function openCreateForm() {
    setPop(null);
    const sel = pending.current;
    if (!sel) return;
    setNoteDraft('');
    setNoteForm({ mode: 'create', start: sel.start, end: sel.end, quote: text.slice(sel.start, sel.end) });
  }

  function saveNoteForm() {
    if (!noteForm) return;
    const note = noteDraft.trim();
    if (noteForm.mode === 'create') {
      annMutations.add.mutate(
        {
          char_start: noteForm.start,
          char_end: noteForm.end,
          content: { kind: 'highlight', note, source: 'human' },
        },
        {
          onSuccess: () => {
            pending.current = null;
            window.getSelection()?.removeAllRanges();
          },
        },
      );
    } else {
      const a = items.find((x) => x.id === noteForm.id);
      if (a) annMutations.edit.mutate({ id: noteForm.id, content: { ...(a.content ?? {}), note } });
    }
    setNoteForm(null);
  }

  // Make one annotation the active one and bring its mark into view.
  // AnnotatedText scrolls on its own when the active id changes; tapping the
  // already-active one again still re-scrolls, so the explicit call stays.
  function focusAnn(id: string) {
    setActiveId(id);
    if (id === activeId) scrollToMark(textRef.current, id);
  }

  function deleteAnn(a: Annotation) {
    const sel = a.selector;
    const restorable = a.state !== 'lost' && a.state !== 'unresolved' && sel;
    annMutations.remove.mutate(a.id);
    push('Annotation deleted', {
      tone: 'info',
      ...(restorable
        ? {
            actionLabel: 'Undo',
            onAction: () =>
              annMutations.add.mutate({
                char_start: sel.char_start,
                char_end: sel.char_end,
                content: a.content ?? {},
                needs_review: !!a.needs_review,
              }),
          }
        : {}),
    });
  }

  // --- Batch / one-off research over annotations ---

  function buildItems(ids: string[]) {
    const replyTo = resolveDocOwner(doc, state.entries);
    if (!replyTo) {
      setBatchMsg('Cannot resolve the source entry for this document.');
      return null;
    }
    const contextIds = contextChain(state.entries, replyTo).map((c) => c.id);
    const out: { reply_to: string; question: string; re_quote: string; context_ids: string[]; mode: string }[] = [];
    let skipped = 0;
    for (const id of ids) {
      const a = items.find((x) => x.id === id);
      if (!a) continue;
      const note = a.content?.note ?? '';
      if (!note.trim()) {
        skipped++;
        continue;
      }
      out.push({
        reply_to: replyTo,
        question: note,
        re_quote: a.selector?.exact ?? '',
        context_ids: contextIds,
        mode: modes[id] === 'deep' ? 'deep' : 'regular',
      });
    }
    return { items: out, skipped };
  }

  async function researchOne(id: string) {
    const a = items.find((x) => x.id === id);
    if (!a) return;
    if (!(a.content?.note ?? '').trim()) {
      setBatchMsg('This annotation has no note — add a note first.');
      return;
    }
    const built = buildItems([id]);
    if (!built || !built.items.length) return;
    try {
      await mutations.annotationBatch.mutateAsync(built.items);
    } catch (err) {
      setBatchMsg(err instanceof ApiError ? err.message || 'Research request failed.' : 'Network error — try again.');
      return;
    }
    setBatchMsg('Sent 1 question to research.');
  }

  async function sendBatch() {
    const built = buildItems(Array.from(selected));
    if (!built) return;
    const { items: batchItems, skipped } = built;
    if (!batchItems.length) {
      setBatchMsg(
        skipped
          ? `${skipped} annotation${skipped === 1 ? '' : 's'} skipped (no note). Nothing to send.`
          : 'Select annotations with notes first.',
      );
      return;
    }
    let count = batchItems.length;
    try {
      const res = await mutations.annotationBatch.mutateAsync(batchItems);
      if (res.count != null) count = res.count;
    } catch (err) {
      setBatchMsg(err instanceof ApiError ? err.message || 'Batch send failed.' : 'Network error — try again.');
      return;
    }
    setBatchMsg(
      `Sent ${count} question${count === 1 ? '' : 's'} to research${skipped ? ` (${skipped} skipped — no note)` : ''}.`,
    );
    setSelected(new Set());
  }

  function followUp(a: Annotation) {
    const noteId = resolveDocOwner(doc, state.entries);
    if (!noteId) return;
    onClose();
    actions.startFollowUp(noteId, a.selector?.exact ?? '');
  }

  // --- Render ---

  const sorted = items
    .slice()
    .sort(
      (a, b) => (a.selector ? a.selector.char_start : Number.MAX_SAFE_INTEGER) -
        (b.selector ? b.selector.char_start : Number.MAX_SAFE_INTEGER),
    );
  const nSel = selected.size;
  const allSel = items.length > 0 && nSel === items.length;

  return (
    <>
      <div
        className={readerStyles.overlay}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={`${readerStyles.panel} ${styles.panel}`}>
          <div className={readerStyles.head}>
            <div className={readerStyles.headText}>
              <div className={readerStyles.title}>{title}</div>
              <div className={readerStyles.file}>{doc}</div>
            </div>
            <button type="button" className={readerStyles.headBtn} title="Close" aria-label="Close" onClick={onClose}>
              &times;
            </button>
          </div>
          <div className={styles.main}>
            <AnnotatedText
              ref={textRef}
              className={styles.text}
              text={text}
              annotations={items}
              activeId={activeId}
              loading={textQuery.isLoading}
              onMarkClick={focusAnn}
              onSelectRange={onSelectRange}
              onSelectionClear={() => setPop(null)}
            />

            <div className={styles.list}>
              <div className={styles.batchBar}>
                <button
                  type="button"
                  className={styles.batchSelectBtn}
                  disabled={items.length === 0}
                  onClick={() => setSelected(allSel ? new Set() : new Set(items.map((a) => a.id)))}
                >
                  {allSel ? 'Deselect all' : 'Select all'}
                </button>
                <span className={styles.batchCount}>
                  {nSel} of {items.length} selected
                </span>
                <button type="button" className={styles.batchSendBtn} disabled={nSel === 0} onClick={() => void sendBatch()}>
                  &#128300; Send {nSel} as research
                </button>
              </div>
              {batchMsg ? <div className={styles.batchMsg}>{batchMsg}</div> : null}

              {sorted.length ? (
                sorted.map((a) => {
                  const q = a.selector?.exact ?? '';
                  const note = a.content?.note ?? '';
                  const isSel = selected.has(a.id);
                  const mode = modes[a.id] ?? 'regular';
                  const deleteKey = `ann:${a.id}`;
                  const armed = confirmKey === deleteKey;
                  return (
                    <div key={a.id} className={styles.row}>
                      <button type="button" className={styles.quote} onClick={() => focusAnn(a.id)}>
                        &ldquo;{truncate(q, 120)}&rdquo;
                      </button>
                      {note ? <div className={styles.note}>{note}</div> : null}
                      <div className={styles.chips}>
                        <button
                          type="button"
                          className={`${pageStyles.chip} ${a.needs_review ? pageStyles.chipInteresting : pageStyles.chipVerified}`}
                          onClick={() => annMutations.edit.mutate({ id: a.id, needs_review: !a.needs_review })}
                        >
                          {a.needs_review ? '○ review' : '✓ reviewed'}
                        </button>
                        {a.content?.source === 'llm' ? <span className={`${pageStyles.chip} ${pageStyles.chipStatic}`}>llm</span> : null}
                        {a.state === 'relocated' ? (
                          <span className={`${pageStyles.chip} ${pageStyles.chipStatic}`} title="The text shifted; re-anchored by its exact quote">
                            &#8635; relocated
                          </span>
                        ) : a.state === 'lost' ? (
                          <span
                            className={`${pageStyles.chip} ${pageStyles.chipStatic} ${pageStyles.chipShaky}`}
                            title="The quoted text no longer appears in this document"
                          >
                            &#9888; lost
                          </span>
                        ) : null}
                        <input
                          type="checkbox"
                          className={styles.selectCb}
                          checked={isSel}
                          title="Select for batch research"
                          onChange={() =>
                            setSelected((cur) => {
                              const next = new Set(cur);
                              if (next.has(a.id)) next.delete(a.id);
                              else next.add(a.id);
                              return next;
                            })
                          }
                        />
                        <button
                          type="button"
                          className={pageStyles.chip}
                          title="Toggle deep/regular"
                          onClick={() =>
                            setModes((cur) => ({ ...cur, [a.id]: cur[a.id] === 'deep' ? 'regular' : 'deep' }))
                          }
                        >
                          {mode === 'deep' ? '🔬 deep' : '🔍 regular'}
                        </button>
                        <button
                          type="button"
                          className={pageStyles.chip}
                          title="Research this annotation"
                          onClick={() => void researchOne(a.id)}
                        >
                          &#128300;
                        </button>
                        <button type="button" className={pageStyles.chip} onClick={() => followUp(a)}>
                          &#8627; follow up
                        </button>
                        <button
                          type="button"
                          className={pageStyles.chip}
                          onClick={() => {
                            setNoteDraft(note);
                            setNoteForm({ mode: 'edit', id: a.id, quote: q });
                          }}
                        >
                          edit
                        </button>
                        <button
                          type="button"
                          className={`${pageStyles.chip} ${armed ? pageStyles.chipSure : pageStyles.chipDanger}`}
                          onClick={() => {
                            if (requestConfirm(deleteKey)) deleteAnn(a);
                          }}
                        >
                          {armed ? 'Sure?' : '× delete'}
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className={styles.empty}>
                  No annotations yet &mdash; select some text in the document to make the first one.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {pop ? (
        <button type="button" className={styles.pop} style={{ left: pop.left, top: pop.top }} onClick={openCreateForm}>
          &#9998; Annotate
        </button>
      ) : null}

      {noteForm ? (
        <div className={styles.noteForm}>
          <div className={styles.noteFormLabel}>{noteForm.mode === 'create' ? 'Annotation note (optional):' : 'Annotation note:'}</div>
          {noteForm.quote ? <div className={styles.noteFormQuote}>&ldquo;{truncate(noteForm.quote, 160)}&rdquo;</div> : null}
          <textarea
            className={styles.noteFormArea}
            value={noteDraft}
            autoFocus
            onChange={(e) => setNoteDraft(e.target.value)}
          />
          <div className={styles.noteFormBtns}>
            <button type="button" className={pageStyles.outlineBtn} onClick={() => setNoteForm(null)}>
              Cancel
            </button>
            <button type="button" className={pageStyles.primaryBtn} onClick={saveNoteForm}>
              Save
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
