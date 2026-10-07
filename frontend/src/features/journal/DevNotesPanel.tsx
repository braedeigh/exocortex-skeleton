import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import { useDevNoteMutations, useJournalDevNotes } from './useJournalData';
import { useGreenlight } from '../nightcrew/useGreenlight';
import styles from './DevNotesPanel.module.css';
import { isStandalone } from '../../shell/standalone';

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
 *
 * THE MOON BUTTON green-lights a note for the night crew (POST
 * /api/nightcrew/notes/<id>/greenlight). It sits inline on the row rather than
 * behind a separate triage page on purpose: a triage page is a threshold, and
 * thresholds don't get crossed at 11 PM when she's tired. The tap is allowed
 * to be WRONG — tools/nightcrew/triage.py is the net under it, and when the
 * net catches one the row says so immediately instead of failing silently
 * overnight.
 */
export function DevNotesPanel({ open, onClose, onError }: DevNotesPanelProps) {
  const { data } = useJournalDevNotes();
  const { add, edit, remove } = useDevNoteMutations(onError);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const night = useGreenlight(onError);

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
        <Button onClick={submitDraft} data-track="dev-note-add">
          Add
        </Button>
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
                {night.reasonFor(n.id) ? (
                  <div className={styles.gateNote}>Night crew won&rsquo;t take this — {night.reasonFor(n.id)}</div>
                ) : null}
                {n.night_questions ? (
                  <div className={styles.askNote}>Night crew asks — edit the note to answer:{'\n'}{n.night_questions}</div>
                ) : null}
              </div>
              {/* The moon sends a note to the night crew, which only the
                  owner's own install has. */}
              {isStandalone() ? null : (
                <IconButton
                  aria-label={night.isOn(n.id, n.night === true) ? 'Remove from tonight' : 'Send to the night crew'}
                  onClick={() => night.toggle(n.id, !night.isOn(n.id, n.night === true))}
                  data-track="dev-note-night"
                >
                  <span className={night.isOn(n.id, n.night === true) ? styles.nightOn : styles.nightOff}>☾</span>
                </IconButton>
              )}
              <IconButton aria-label="Edit note" onClick={() => startEdit(n.id, n.text)} data-track="dev-note-edit">
                &#9998;
              </IconButton>
              <IconButton
                aria-label={confirmDeleteId === n.id ? 'Confirm delete note' : 'Delete note'}
                danger={confirmDeleteId === n.id}
                onClick={() => requestDelete(n.id)}
                data-track="dev-note-delete"
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
