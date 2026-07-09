import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import type { Streak } from '../habits/types';
import styles from './StreakSheet.module.css';

export interface StreakSheetProps {
  streak: Streak | null;
  open: boolean;
  onClose: () => void;
  onSaveNotes: (label: string, since: string, notes: string) => void;
  onRemove: (label: string, since: string) => void;
}

/**
 * Streak detail — port of openStreakDetail (core.js): the "Day N <label>"
 * chip's notes (dosage, changes, milestones) behind a read view + Edit/Save
 * toggle, plus the started date and a confirm-first delete.
 * TODO(habits phase 2): the legacy modal's "track as a daily habit" linkage
 * (section checkboxes + course length via /api/habits/configure) comes back
 * with the habit config modal.
 */
export function StreakSheet({ streak, open, onClose, onSaveNotes, onRemove }: StreakSheetProps) {
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!streak) return;
    setNotes(streak.notes || '');
    setEditing(false);
    setConfirmingRemove(false);
  }, [streak]);

  useEffect(() => {
    if (editing) notesInputRef.current?.focus();
  }, [editing]);

  if (!open || !streak) return null;

  function save() {
    if (!streak) return;
    onSaveNotes(streak.label, streak.since, notes.trim());
    setEditing(false);
  }

  return (
    <Sheet open={open} title={`Day ${streak.days} · ${streak.label}`} onClose={onClose}>
      <div className={styles.meta}>Started {streak.since}</div>

      <div className={styles.field}>
        {editing ? (
          <textarea
            ref={notesInputRef}
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Dosage, changes, milestones…"
            aria-label="Notes"
          />
        ) : (
          <button type="button" className={styles.notesDisplay} onClick={() => setEditing(true)}>
            {streak.notes ? streak.notes : <span className={styles.placeholder}>No notes yet — tap to add</span>}
          </button>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {editing ? (
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>

      <div className={styles.dangerZone}>
        {confirmingRemove ? (
          <div className={styles.confirmRow}>
            <span className={styles.confirmText}>Remove this day count?</span>
            <Button variant="secondary" onClick={() => setConfirmingRemove(false)}>
              Cancel
            </Button>
            <IconButton
              danger
              aria-label="Confirm remove"
              onClick={() => {
                onRemove(streak.label, streak.since);
                onClose();
              }}
            >
              &times;
            </IconButton>
          </div>
        ) : (
          <Button variant="danger" fullWidth onClick={() => setConfirmingRemove(true)}>
            Remove day count
          </Button>
        )}
      </div>
    </Sheet>
  );
}
