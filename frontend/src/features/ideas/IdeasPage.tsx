import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import type { DevNote } from '../journal/types';
import { ideasTabLabel, visibleIdeaTabs } from './byPage';
import { readCardOpen, writeCardOpen } from './cardState';
import { countBullets, ideasMdBlock, ideasMdInline, parseIdeaSections, preambleBody } from './ideasDoc';
import { useIdeaMutations, useIdeaNotesAll, useIdeasDoc, useIdeasDocSave } from './useIdeasData';
import styles from './IdeasPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * /ideas — port of the legacy Ideas tab (templates/index.html #tab-ideas +
 * static/js/ideas.js). Two halves: every page's idea notes grouped into
 * collapsible per-tab cards (add under General, inline edit, two-step delete
 * with an undo toast), then the IDEAS.md vision doc rendered as collapsible
 * ## section cards with a raw-markdown editor behind "Edit raw". Card
 * open/closed states persist under the legacy mapCardOpen:* keys.
 */
export function IdeasPage() {
  const isPublic = isPublicMode();

  const notesQuery = useIdeaNotesAll(!isPublic);
  const docQuery = useIdeasDoc(!isPublic);
  const { toasts, push, dismiss } = useToasts();
  const { add, edit, remove } = useIdeaMutations(push, (_removed, undo) => {
    push('Idea removed', { tone: 'info', actionLabel: 'Undo', onAction: undo });
  });

  // --- by-page state ---
  const [editing, setEditing] = useState<{ tab: string; id: string } | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState('');
  // Cards the user has toggled this visit; anything else falls back to
  // localStorage / the default (only General starts open).
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const addRef = useRef<HTMLTextAreaElement>(null);

  // --- vision doc state ---
  const [docEditing, setDocEditing] = useState(false);
  const [docDraft, setDocDraft] = useState('');
  const docSave = useIdeasDocSave(push, () => setDocEditing(false));

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  // Grow + focus the edit box when a row enters edit mode (legacy ideasOvEdit
  // focused with the cursor at the end).
  useEffect(() => {
    const ta = editRef.current;
    if (!ta) return;
    autosize(ta);
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }, [editing]);

  const tabsMap = notesQuery.data?.tabs;
  const tabs = useMemo(() => visibleIdeaTabs(tabsMap), [tabsMap]);

  const docMd = docQuery.data?.content ?? '';
  const docSections = useMemo(() => (docMd.trim() ? parseIdeaSections(docMd) : null), [docMd]);
  const docPreHtml = useMemo(() => {
    if (!docSections) return '';
    const body = preambleBody(docSections[0]);
    return body ? ideasMdBlock(body) : '';
  }, [docSections]);

  function cardOpen(card: string, fallback: boolean): boolean {
    return openCards[card] ?? readCardOpen(card, fallback);
  }

  function onCardToggle(card: string, e: SyntheticEvent<HTMLDetailsElement>) {
    const open = e.currentTarget.open;
    setOpenCards((cur) => (cur[card] === open ? cur : { ...cur, [card]: open }));
    writeCardOpen(card, open);
  }

  function startEdit(tab: string, n: DevNote) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmDeleteKey(null);
    setEditing({ tab, id: n.id });
    setEditDraft(n.text);
  }

  function saveEdit() {
    if (!editing) return;
    const text = editDraft.trim();
    if (!text) return;
    edit(editing.tab, editing.id, text);
    setEditing(null);
  }

  function requestDelete(tab: string, id: string) {
    const key = `${tab}:${id}`;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmDeleteKey === key) {
      setConfirmDeleteKey(null);
      remove(tab, id);
      return;
    }
    setConfirmDeleteKey(key);
    confirmTimer.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
  }

  function submitAdd() {
    const text = addDraft.trim();
    if (!text) return;
    add('general', text);
    setAddDraft('');
    const ta = addRef.current;
    if (ta) requestAnimationFrame(() => autosize(ta));
  }

  // Enter adds, Shift+Enter makes a newline — same as every add box here.
  function onAddKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitAdd();
    }
  }

  function startDocEdit() {
    setDocDraft(docMd);
    setDocEditing(true);
  }

  if (isPublic) {
    return (
      <div className={styles.page}>
        <div className={styles.publicStub}>Ideas aren&rsquo;t available here.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* --- Ideas by page ------------------------------------------------ */}
      <div className={`${styles.sectionTitle} ${styles.firstTitle}`}>Ideas</div>
      <div className={styles.hint}>
        Ideas sorted by page. Send one here from any page&rsquo;s dev notes with &#128161;, or add directly under
        General.
      </div>

      {notesQuery.isLoading ? (
        <div className={styles.empty}>Loading&hellip;</div>
      ) : notesQuery.isError ? (
        <div className={styles.empty}>Failed to load ideas.</div>
      ) : (
        tabs.map((tab) => {
          const notes = tabsMap?.[tab] ?? [];
          const card = `ideas-${tab}`;
          return (
            <details
              key={tab}
              className={styles.pageCard}
              open={cardOpen(card, tab === 'general')}
              onToggle={(e) => onCardToggle(card, e)}
            >
              <summary className={styles.cardSummary}>
                <span className={styles.arrow}>&#9654;</span>
                <span className={styles.cardTitle}>{ideasTabLabel(tab)}</span>
                {notes.length ? <span className={styles.countBadge}>{notes.length}</span> : null}
              </summary>

              {notes.length === 0 ? (
                <div className={styles.emptyRow}>Nothing here yet</div>
              ) : (
                notes.map((n) => {
                  const key = `${tab}:${n.id}`;
                  if (editing && editing.tab === tab && editing.id === n.id) {
                    return (
                      <div key={n.id} className={styles.editRow}>
                        <textarea
                          ref={editRef}
                          className={styles.editArea}
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onInput={(e) => autosize(e.currentTarget)}
                        />
                        <div className={styles.editBtnCol}>
                          <button type="button" className={styles.saveBtn} onClick={saveEdit}>
                            Save
                          </button>
                          <button type="button" className={styles.cancelBtn} onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={n.id} className={styles.row}>
                      <div className={styles.rowText}>{n.text}</div>
                      <div className={styles.rowDate}>{n.created || ''}</div>
                      <button
                        type="button"
                        className={styles.act}
                        title="Edit"
                        aria-label="Edit idea"
                        onClick={() => startEdit(tab, n)}
                      >
                        &#9998;
                      </button>
                      <button
                        type="button"
                        className={`${styles.act} ${styles.actX} ${confirmDeleteKey === key ? styles.actSure : ''}`}
                        title="Remove"
                        aria-label={confirmDeleteKey === key ? 'Confirm remove idea' : 'Remove idea'}
                        onClick={() => requestDelete(tab, n.id)}
                      >
                        {confirmDeleteKey === key ? 'Sure?' : <>&times;</>}
                      </button>
                    </div>
                  );
                })
              )}

              {tab === 'general' ? (
                <div className={styles.addRow}>
                  <textarea
                    ref={addRef}
                    rows={1}
                    className={styles.addInput}
                    placeholder="A new idea…"
                    value={addDraft}
                    onChange={(e) => setAddDraft(e.target.value)}
                    onInput={(e) => autosize(e.currentTarget)}
                    onKeyDown={onAddKeyDown}
                  />
                  <button type="button" className={styles.addBtn} onClick={submitAdd}>
                    Add
                  </button>
                </div>
              ) : null}
            </details>
          );
        })
      )}

      {/* --- Vision doc (IDEAS.md) ---------------------------------------- */}
      {docEditing ? (
        <>
          <div className={`${styles.sectionTitle} ${styles.docHeader}`}>
            <span className={styles.docHeaderLabel}>
              Vision doc <span className={styles.docSub}>IDEAS.md &mdash; raw</span>
            </span>
            <button
              type="button"
              className={styles.cardEditBtn}
              onClick={() => docSave.mutate(docDraft)}
              disabled={docSave.isPending}
            >
              Save
            </button>
            <button type="button" className={styles.cardEditBtn} onClick={() => setDocEditing(false)}>
              Cancel
            </button>
          </div>
          <textarea
            className={styles.docEditor}
            spellCheck={false}
            value={docDraft}
            onChange={(e) => setDocDraft(e.target.value)}
          />
        </>
      ) : (
        <>
          <div className={`${styles.sectionTitle} ${styles.docHeader}`}>
            <span className={styles.docHeaderLabel}>
              Vision doc <span className={styles.docSub}>IDEAS.md &mdash; the big scratchpad, kept as-is for now</span>
            </span>
            <button type="button" className={styles.cardEditBtn} onClick={startDocEdit}>
              Edit raw
            </button>
          </div>

          {docQuery.isLoading ? (
            <div className={styles.empty}>Loading&hellip;</div>
          ) : !docSections ? (
            <div className={styles.docEmpty}>No vision doc yet.</div>
          ) : (
            <>
              {docPreHtml ? (
                <div
                  className={`${styles.docPre} ${styles.mdBody}`}
                  dangerouslySetInnerHTML={{ __html: docPreHtml }}
                />
              ) : null}
              {docSections.slice(1).map((sec, i) => {
                const card = `ideas-doc-${i}`;
                const bullets = countBullets(sec.lines);
                return (
                  <details
                    key={card}
                    className={styles.docSection}
                    open={cardOpen(card, false)}
                    onToggle={(e) => onCardToggle(card, e)}
                  >
                    <summary className={styles.docSummary}>
                      <span className={styles.arrow}>&#9654;</span>
                      <span
                        className={styles.docSectionTitle}
                        dangerouslySetInnerHTML={{ __html: ideasMdInline(sec.title ?? '') }}
                      />
                      {bullets ? <span className={styles.docCount}>{bullets}</span> : null}
                    </summary>
                    <div
                      className={`${styles.docBody} ${styles.mdBody}`}
                      dangerouslySetInnerHTML={{ __html: ideasMdBlock(sec.lines.join('\n').trim()) }}
                    />
                  </details>
                );
              })}
            </>
          )}
        </>
      )}

      {/* Notes about the Ideas page itself land on the 'ideas' tab. */}
      <NotesPill tab="ideas" onError={push} />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
