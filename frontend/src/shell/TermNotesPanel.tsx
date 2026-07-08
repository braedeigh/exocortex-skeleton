import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import { useDismiss } from './useDismiss';
import { addTermNote, editTermNote, getTermNotes, removeTermNote, type DevNote } from './shellApi';
import styles from './TermNotesPanel.module.css';

/**
 * Terminal notes panel — React port of split.html's #termNotesPanel
 * (templates/split.html:514-523, 1131-1374). Bugs/ideas for the terminal,
 * filed to dev notes under the 'terminal' tab (same store the PWA 📝 writes
 * to, routes/devnotes.py).
 *
 * Dev notes that shaped this:
 * - Enter posts, Shift+Enter inserts a newline.
 * - The textarea auto-grows while typing (desktop).
 * - Click outside closes it — but clicking edit/delete *inside* the panel
 *   must not (see useDismiss's pointerdown-time containment check).
 */
export function TermNotesPanel({
  open,
  onClose,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [notes, setNotes] = useState<DevNote[]>([]);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useDismiss(open, onClose, panelRef, triggerRef);

  const load = () => {
    getTermNotes()
      .then((data) => setNotes(data.notes || []))
      .catch(() => setNotes([]));
  };

  useEffect(() => {
    if (open) {
      load();
      // Focus after the panel has painted, matching the old .focus() on open.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setConfirmDeleteId(null);
      setEditingId(null);
    }
  }, [open]);

  const submitDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    await addTermNote(text);
    setDraft('');
    load();
  };

  const onDraftKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitDraft();
    }
  };

  const onDraftInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const startEdit = (n: DevNote) => {
    clearTimeout(confirmTimer.current ?? undefined);
    setConfirmDeleteId(null);
    setEditingId(n.id);
    setEditText(n.text);
  };

  const saveEdit = async () => {
    const text = editText.trim();
    if (!text || !editingId) return;
    await editTermNote(editingId, text);
    setEditingId(null);
    load();
  };

  const onDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      clearTimeout(confirmTimer.current ?? undefined);
      setConfirmDeleteId(id);
      confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    clearTimeout(confirmTimer.current ?? undefined);
    setConfirmDeleteId(null);
    await removeTermNote(id);
    load();
  };

  if (!open) return null;

  return (
    <div className={styles.panel} ref={panelRef}>
      <div className={styles.composer}>
        <textarea
          ref={inputRef}
          className={styles.input}
          rows={2}
          placeholder="Bug or idea for the terminal…"
          value={draft}
          onChange={onDraftInput}
          onKeyDown={onDraftKeyDown}
        />
        <button type="button" className={styles.addBtn} onClick={() => void submitDraft()} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      <div className={styles.list}>
        {notes.length === 0 ? (
          <div className={styles.empty}>No terminal notes yet</div>
        ) : (
          notes.map((n) =>
            n.id === editingId ? (
              <div key={n.id} className={[styles.item, styles.editRow].join(' ')}>
                <textarea
                  className={styles.editArea}
                  value={editText}
                  autoFocus
                  onChange={(e) => setEditText(e.target.value)}
                />
                <div className={styles.editBtns}>
                  <button type="button" className={styles.cancelBtn} onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                  <button type="button" className={styles.saveBtn} onClick={() => void saveEdit()}>
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div key={n.id} className={styles.item}>
                <div className={styles.body}>
                  <div className={styles.text}>{n.text}</div>
                  <div className={styles.date}>{n.created}</div>
                </div>
                <button type="button" className={styles.act} title="Edit" aria-label="Edit note" onClick={() => startEdit(n)}>
                  &#9998;
                </button>
                <button
                  type="button"
                  className={[styles.act, confirmDeleteId === n.id ? styles.actDanger : ''].filter(Boolean).join(' ')}
                  title="Delete"
                  aria-label={confirmDeleteId === n.id ? 'Confirm delete note' : 'Delete note'}
                  onClick={() => void onDelete(n.id)}
                >
                  {confirmDeleteId === n.id ? 'Sure?' : '×'}
                </button>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}
