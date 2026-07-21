import { useState } from 'react';
import { Button, IconButton } from '../../ui';
import type { StreakNote } from '../habits/types';
import styles from './StreakNotes.module.css';

export interface StreakNotesProps {
  tag: string;
  notes: StreakNote[];
  loading: boolean;
  onAppend: (tag: string, body: string) => void;
  appending: boolean;
  onEdit: (id: string, body: string) => void;
  onRemove: (id: string) => void;
  /** Retired counters keep their history readable but quiet — no composer. */
  readOnly?: boolean;
}

/** "Jul 20 · 7:43 PM" from a "YYYY-MM-DD HH:MM:SS" card ts — string math
 * only, per house convention (never Date-parse a server ts). */
function cellStamp(ts: string): string {
  const [date, time] = ts.split(' ');
  if (!date || !time) return ts;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = months[parseInt(date.slice(5, 7), 10) - 1] ?? '';
  const day = parseInt(date.slice(8, 10), 10);
  let h = parseInt(time.slice(0, 2), 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${m} ${day} · ${h}:${time.slice(3, 5)} ${ampm}`;
}

/**
 * A counter's note log — the journal/thread cell pattern pointed at a day
 * counter. Each note is a REAL journal card tagged `counter-<slug>`: it
 * appears in the daily journal on its own, and it locks after the rolling
 * 24-hour server-side edit window (editable=false) — after that, the only
 * move is appending a fresh cell, same as thread entries.
 */
export function StreakNotes({
  tag,
  notes,
  loading,
  onAppend,
  appending,
  onEdit,
  onRemove,
  readOnly = false,
}: StreakNotesProps) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  function append() {
    const body = draft.trim();
    if (!body) return;
    onAppend(tag, body);
    setDraft('');
  }

  function saveEdit() {
    if (!editingId) return;
    const body = editDraft.trim();
    if (body) onEdit(editingId, body);
    setEditingId(null);
  }

  return (
    <div className={styles.wrap}>
      {loading ? (
        <div className={styles.empty}>Loading notes…</div>
      ) : notes.length === 0 ? (
        <div className={styles.empty}>{readOnly ? 'No notes were kept.' : 'No notes yet.'}</div>
      ) : (
        <ul className={styles.list}>
          {notes.map((n) => (
            <li key={n.id} className={styles.cell}>
              <div className={styles.cellMeta}>
                <span className={styles.stamp}>{cellStamp(n.ts)}</span>
                {!readOnly && n.editable && editingId !== n.id ? (
                  <span className={styles.cellActions}>
                    <IconButton
                      aria-label="Edit note"
                      onClick={() => {
                        setEditingId(n.id);
                        setEditDraft(n.body);
                        setConfirmingId(null);
                      }}
                    >
                      &#9998;
                    </IconButton>
                    {confirmingId === n.id ? (
                      <IconButton danger aria-label="Confirm remove note" onClick={() => onRemove(n.id)}>
                        &times;
                      </IconButton>
                    ) : (
                      <IconButton aria-label="Remove note" onClick={() => setConfirmingId(n.id)}>
                        &times;
                      </IconButton>
                    )}
                  </span>
                ) : null}
              </div>
              {editingId === n.id ? (
                <>
                  <textarea
                    className={styles.textarea}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    aria-label="Edit note"
                  />
                  <div className={styles.editActions}>
                    <Button variant="secondary" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={saveEdit}>
                      Save
                    </Button>
                  </div>
                </>
              ) : (
                <div className={styles.body}>{n.body}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly ? (
        <div className={styles.composer}>
          <textarea
            className={styles.textarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note — it lands in today’s journal too"
            aria-label="New note"
          />
          <Button variant="primary" fullWidth disabled={appending || !draft.trim()} onClick={append}>
            + Note
          </Button>
        </div>
      ) : null}
    </div>
  );
}
