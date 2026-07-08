import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import { useDevNoteMutations, useJournalDevNotes } from './useJournalData';
import styles from './DevNotesPanel.module.css';

export interface DevNotesPanelProps {
  open: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * Journal-tab dev notes. Editing/deleting a note must NOT close the panel
 * (the legacy mini-notes.js had this bug via a document-level click-outside
 * listener that mistook a re-render for an outside click) — since this
 * panel's open state lives entirely in JournalPage and mutations only ever
 * invalidate the notes query, that class of bug can't happen here.
 */
export function DevNotesPanel({ open, onClose, onError }: DevNotesPanelProps) {
  const { data } = useJournalDevNotes();
  const { add, edit, remove } = useDevNoteMutations(onError);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      setEditingId(null);
      setConfirmDeleteId(null);
    }
  }, [open]);

  function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    add(text);
    setDraft('');
  }

  function startEdit(id: string, text: string) {
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

  const notes = data?.notes ?? [];

  return (
    <Sheet open={open} onClose={onClose} title="Journal dev notes">
      <div className={styles.composer}>
        <textarea
          className={styles.composerInput}
          rows={2}
          placeholder="Bug or idea for the journal…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitDraft();
            }
          }}
        />
        <Button onClick={submitDraft}>Add</Button>
      </div>

      <div className={styles.list}>
        {notes.length === 0 ? <div className={styles.empty}>No journal notes yet</div> : null}
        {notes.map((n) =>
          editingId === n.id ? (
            <div className={styles.item} key={n.id}>
              <textarea className={styles.editInput} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
              <div className={styles.editActions}>
                <Button variant="secondary" onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={saveEdit}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.item} key={n.id}>
              <div className={styles.itemBody}>
                <div className={styles.itemText}>{n.text}</div>
                <div className={styles.itemDate}>{n.created}</div>
              </div>
              <IconButton aria-label="Edit note" onClick={() => startEdit(n.id, n.text)}>
                &#9998;
              </IconButton>
              <IconButton
                aria-label={confirmDeleteId === n.id ? 'Confirm delete note' : 'Delete note'}
                danger={confirmDeleteId === n.id}
                onClick={() => requestDelete(n.id)}
              >
                {confirmDeleteId === n.id ? '?' : <>&times;</>}
              </IconButton>
            </div>
          ),
        )}
      </div>
    </Sheet>
  );
}
