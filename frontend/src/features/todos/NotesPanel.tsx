import { forwardRef, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useNotesPillList, useNotesPillMutations, type NotesPillKind } from './useNotesPill';
import { formatNoteAge, isLongNote, sortNotesByCreated } from './noteHelpers';
import styles from './NotesPill.module.css';

export interface NotesPanelProps {
  kind: NotesPillKind;
  tab: string;
  showAllLink: boolean;
  sort: 'newest' | 'oldest';
  onToggleSort: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}

const LABEL: Record<NotesPillKind, string> = { dev: 'Dev notes', idea: 'Ideas' };
const PLACEHOLDER: Record<NotesPillKind, string> = {
  dev: "What's bugging you about this page?",
  idea: 'What could this page become?',
};

/**
 * The open notes-pill panel: list (newest/oldest, edit, two-step delete) +
 * add box pinned to the bottom. Mirrors mini-notes.js's behavior — this
 * component is mounted fresh each time the panel opens (NotesPill only
 * renders it while a kind is selected), so there's no stale edit/delete
 * state to reset between opens, unlike the legacy DOM node which had to be
 * rebuilt by hand for the same reason.
 */
export const NotesPanel = forwardRef<HTMLDivElement, NotesPanelProps>(function NotesPanel(
  { kind, tab, showAllLink, sort, onToggleSort, onClose, onError },
  ref,
) {
  const { data, isLoading } = useNotesPillList(kind, tab);
  const { add, edit, remove } = useNotesPillMutations(kind, tab, onError);

  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Maximize + per-note tap-to-expand. Both live here (not lifted to
  // NotesPill) because this component is mounted fresh each time the panel
  // opens — see the class doc above — so they self-reset on close for free.
  const [expanded, setExpanded] = useState(false);
  const [expandedNoteIds, setExpandedNoteIds] = useState<ReadonlySet<string>>(() => new Set());
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ta = editRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }, [editingId]);

  const notes = data?.notes ?? [];
  const sorted = sortNotesByCreated(notes, sort);

  function toggleNoteExpanded(id: string) {
    setExpandedNoteIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    add(text);
    setDraft('');
  }

  // Enter sends, Shift+Enter makes a newline (dev note b3e6b136).
  function onDraftKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitDraft();
    }
  }

  function startEdit(id: string, text: string) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmDeleteId(null);
    setEditingId(id);
    setEditDraft(text);
  }

  function saveEdit() {
    const text = editDraft.trim();
    if (!text || !editingId) return;
    edit(editingId, text);
    setEditingId(null);
  }

  function requestDelete(id: string) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmDeleteId === id) {
      setConfirmDeleteId(null);
      remove(id);
      return;
    }
    setConfirmDeleteId(id);
    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  }

  return (
    <div className={`${styles.panel} ${expanded ? styles.panelExpanded : ''}`} ref={ref}>
      <div className={styles.head}>
        <span className={`${styles.title} ${kind === 'idea' ? styles.titleIdea : ''}`}>{LABEL[kind]}</span>
        {showAllLink ? (
          <Link
            to="/notes"
            className={styles.allLink}
            title="Browse all notes"
            aria-label="Browse all notes"
            onClick={onClose}
          >
            &#8599;
          </Link>
        ) : null}
        <button type="button" className={styles.sort} onClick={onToggleSort}>
          {/* ︎ = text variation selector: stops iOS rendering the arrow as emoji */}
          {sort === 'newest' ? '\u2193\uFE0E Newest' : '\u2191\uFE0E Oldest'}
        </button>
        <button
          type="button"
          className={`${styles.maximize} ${expanded ? styles.maximizeActive : ''}`}
          title={expanded ? 'Restore' : 'Maximize'}
          aria-label={expanded ? 'Restore panel' : 'Maximize panel'}
          onClick={() => setExpanded((v) => !v)}
        >
          &#9974;
        </button>
        <button type="button" className={styles.close} title="Close" aria-label="Close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className={styles.list}>
        {isLoading ? null : sorted.length === 0 ? (
          <div className={styles.empty}>No notes here yet</div>
        ) : (
          sorted.map((n) =>
            n.id === editingId ? (
              <div key={n.id} className={`${styles.item} ${styles.itemEditing}`}>
                <textarea
                  ref={editRef}
                  className={styles.editArea}
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = 'auto';
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                />
                <div className={styles.editBtns}>
                  <button type="button" className={styles.cancelBtn} onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                  <button type="button" className={styles.saveBtn} onClick={saveEdit}>
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div key={n.id} className={styles.item}>
                <div className={styles.body}>
                  {isLongNote(n.text) ? (
                    <div
                      className={styles.textWrap}
                      onClick={() => toggleNoteExpanded(n.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleNoteExpanded(n.id);
                        }
                      }}
                    >
                      <div className={`${styles.text} ${expandedNoteIds.has(n.id) ? '' : styles.textClamped}`}>
                        {n.text}
                      </div>
                      <span className={styles.moreHint}>{expandedNoteIds.has(n.id) ? '▲ less' : '▼ more'}</span>
                    </div>
                  ) : (
                    <div className={styles.text}>{n.text}</div>
                  )}
                  {n.created ? <div className={styles.date}>{formatNoteAge(n.created)}</div> : null}
                </div>
                <div className={styles.acts}>
                  <button
                    type="button"
                    className={`${styles.act} ${styles.actX} ${confirmDeleteId === n.id ? styles.actSure : ''}`}
                    title="Delete"
                    aria-label={confirmDeleteId === n.id ? 'Confirm delete note' : 'Delete note'}
                    onClick={() => requestDelete(n.id)}
                  >
                    {confirmDeleteId === n.id ? 'Sure?' : <>&times;</>}
                  </button>
                  <button
                    type="button"
                    className={styles.act}
                    title="Edit"
                    aria-label="Edit note"
                    onClick={() => startEdit(n.id, n.text)}
                  >
                    &#9998;
                  </button>
                </div>
              </div>
            ),
          )
        )}
      </div>

      <div className={styles.add}>
        <textarea
          ref={inputRef}
          rows={2}
          placeholder={PLACEHOLDER[kind]}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onDraftKeyDown}
        />
        <button type="button" onClick={submitDraft}>
          Add
        </button>
      </div>
    </div>
  );
});
