import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDevNote, editDevNote, getDevNotes, removeDevNote } from '../../api/endpoints';
import type { DevNote, DevNotesResponse } from '../journal/types';
import styles from './DevNotesSection.module.css';

const TAB = 'global';
const QUERY_KEY = ['devnotes', TAB] as const;

interface AddRowProps {
  onAdd: (text: string) => void;
  disabled: boolean;
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function AddRow({ onAdd, disabled }: AddRowProps) {
  const [text, setText] = useState('');

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setText('');
  }

  return (
    <div className={styles.addRow}>
      <textarea
        rows={1}
        className={styles.addInput}
        placeholder="A thing to build that doesn't fit a tab..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onInput={(e) => autosize(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="button" className={styles.addBtn} onClick={submit} disabled={disabled}>
        Add
      </button>
    </div>
  );
}

/**
 * Cross-tab dev notes — the 'global' tab of routes/devnotes.py, same
 * endpoints settings.js hit (/api/devnotes/global, /api/devnote/add|edit|
 * remove). Add rows above and below the list (legacy parity), inline edit,
 * two-step delete instead of confirm().
 */
export function DevNotesSection() {
  const queryClient = useQueryClient();
  const notesQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => getDevNotes(TAB, signal),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  useEffect(() => {
    const ta = editRef.current;
    if (editingId && ta) {
      autosize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [editingId]);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }

  const addMutation = useMutation({
    mutationFn: (text: string) => addDevNote(TAB, text),
    onSettled: invalidate,
  });
  const editMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => editDevNote(TAB, id, text),
    onSettled: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => removeDevNote(TAB, id),
    onSettled: invalidate,
  });

  function requestDelete(id: string) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmDeleteId === id) {
      setConfirmDeleteId(null);
      removeMutation.mutate(id);
      return;
    }
    setConfirmDeleteId(id);
    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  }

  function saveEdit(id: string) {
    const text = editDraft.trim();
    if (!text) return;
    editMutation.mutate({ id, text });
    setEditingId(null);
  }

  const notes: DevNote[] = (notesQuery.data as DevNotesResponse | undefined)?.notes ?? [];
  const anyMutating = addMutation.isPending || editMutation.isPending || removeMutation.isPending;

  return (
    <>
      <AddRow onAdd={(t) => addMutation.mutate(t)} disabled={anyMutating} />

      {notesQuery.isLoading ? (
        <div className={styles.empty}>Loading&hellip;</div>
      ) : notesQuery.isError ? (
        <div className={styles.empty}>Failed to load notes.</div>
      ) : notes.length === 0 ? (
        <div className={styles.empty}>No notes yet.</div>
      ) : (
        <div>
          {notes.map((n) =>
            editingId === n.id ? (
              <div key={n.id} className={styles.editWrap}>
                <textarea
                  ref={editRef}
                  className={styles.editArea}
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onInput={(e) => autosize(e.currentTarget)}
                />
                <div className={styles.editBtns}>
                  <button type="button" className={styles.saveBtn} onClick={() => saveEdit(n.id)}>
                    Save
                  </button>
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div key={n.id} className={styles.noteRow}>
                <div className={styles.noteText}>{n.text}</div>
                <div className={styles.noteDate}>{n.created || ''}</div>
                <button
                  type="button"
                  className={styles.act}
                  title="Edit"
                  aria-label="Edit note"
                  onClick={() => {
                    setConfirmDeleteId(null);
                    setEditingId(n.id);
                    setEditDraft(n.text);
                  }}
                >
                  &#9998;
                </button>
                <button
                  type="button"
                  className={`${styles.act} ${styles.actX} ${confirmDeleteId === n.id ? styles.actSure : ''}`}
                  title="Remove"
                  aria-label={confirmDeleteId === n.id ? 'Confirm remove note' : 'Remove note'}
                  onClick={() => requestDelete(n.id)}
                >
                  {confirmDeleteId === n.id ? 'Sure?' : <>&times;</>}
                </button>
              </div>
            ),
          )}
        </div>
      )}

      {notes.length > 0 ? <AddRow onAdd={(t) => addMutation.mutate(t)} disabled={anyMutating} /> : null}
    </>
  );
}
