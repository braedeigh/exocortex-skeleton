import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notesQueryKey } from '../features/todos/useNotesPill';
import { useDismiss } from './useDismiss';
import { addPanelNote, editPanelNote, getPanelNotes, removePanelNote, type DevNote, type PanelNotesTab } from './shellApi';
import styles from './TermNotesPanel.module.css';

// What each room's panel says. The words name the room the note is about, so
// the box itself tells her which list she is writing into.
const ROOM_WORDING: Record<PanelNotesTab, { placeholder: string; empty: string }> = {
  terminal: { placeholder: 'Bug or idea for the terminal…', empty: 'No terminal notes yet' },
  terrain: { placeholder: 'Bug or idea for Terrain…', empty: 'No Terrain notes yet' },
};

/**
 * The 📝 dev-notes panel that drops from a room's top bar — React port of
 * split.html's #termNotesPanel (templates/split.html:514-523, 1131-1374).
 * Bugs/ideas for ONE room, filed to dev notes under that room's own tab
 * (routes/devnotes.py). The room mounting it passes `tab`: the terminal pane,
 * the phone terminal and the Observatory all file under 'terminal' (one list,
 * on purpose — they are the same conversation surface); Terrain files under
 * 'terrain'. Leaving `tab` off means 'terminal'.
 *
 * The roster page's floating notes pill (features/todos/NotesPill) shows the
 * same 'terminal' list through its own cached query, so every change made
 * here also marks that cache stale — see `load` below.
 *
 * Dev notes that shaped this:
 * - Enter posts, Shift+Enter inserts a newline.
 * - The textarea auto-grows while typing (desktop).
 * - Click outside closes it — but clicking edit/delete *inside* the panel
 *   must not (see useDismiss's pointerdown-time containment check).
 */
export function TermNotesPanel({
  tab = 'terminal',
  open,
  onClose,
  triggerRef,
}: {
  tab?: PanelNotesTab;
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

  const queryClient = useQueryClient();

  // Re-read this room's list after opening or after any change. `changed` is
  // true when this panel just wrote something: the notes pill and the /notes
  // browser keep their own cached copies of the same tab, so they are marked
  // stale here — otherwise a note added beside a session would be missing from
  // the roster's pill until its cache aged out. This is cache invalidation.
  // Prompt: "make the notes button on both every session and the roster page
  // contain the same notes"
  const load = (changed = false) => {
    if (changed) {
      void queryClient.invalidateQueries({ queryKey: notesQueryKey('dev', tab) });
      void queryClient.invalidateQueries({ queryKey: ['notesAll', 'dev'] });
    }
    getPanelNotes(tab)
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
  }, [open, tab]);

  const submitDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    await addPanelNote(tab, text);
    setDraft('');
    // onDraftInput grows the textarea by writing a pixel height straight to
    // the DOM node (needed since it auto-grows while typing) — clearing
    // `draft` alone doesn't touch that inline style, so without this the box
    // stays at its expanded size after the note posts instead of collapsing
    // back to its initial small size ("the expansion of the note add remains
    // after i send the note").
    if (inputRef.current) inputRef.current.style.height = '';
    load(true);
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
    await editPanelNote(tab, editingId, text);
    setEditingId(null);
    load(true);
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
    await removePanelNote(tab, id);
    load(true);
  };

  if (!open) return null;

  return (
    <div className={styles.panel} ref={panelRef}>
      <div className={styles.composer}>
        <textarea
          ref={inputRef}
          className={styles.input}
          rows={2}
          placeholder={ROOM_WORDING[tab].placeholder}
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
          <div className={styles.empty}>{ROOM_WORDING[tab].empty}</div>
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
