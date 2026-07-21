import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import type { HabitSection, HabitsLog, Streak } from '../habits/types';
import { habitKey, isHabitDoneOn } from '../habits/habitMath';
import { StreakNotes } from './StreakNotes';
import { useStreakNotes } from './useTodayData';
import styles from './StreakSheet.module.css';

export interface StreakSheetActions {
  saveNotes: (id: string, notes: string) => void;
  setHabit: (id: string, habitKey: string) => void;
  remove: (id: string) => void;
  retire: (id: string, note: string) => void;
}

export interface StreakSheetProps {
  streak: Streak | null;
  open: boolean;
  onClose: () => void;
  actions: StreakSheetActions;
  /** For the habit-link selector + today's check-off state. */
  habits: HabitSection[];
  habitsLog: HabitsLog;
  serverDate: string;
  onError: (message: string) => void;
}

/**
 * Streak detail — "Day N <label>" chip's home. Three quiet layers:
 * description (the old freeform notes, small-until-edit), the linked habit
 * (habit_key -> habits page vocabulary, with today's check-off state), and
 * the note log (append-only cells, real journal cards — see StreakNotes).
 * Retiring lives above the danger zone: it ends the count with a note, weaves
 * a "⏹ retired day count" line into today's journal, and moves the counter
 * to the Life Map's Retired card. Remove stays the destructive last resort.
 */
export function StreakSheet({ streak, open, onClose, actions, habits, habitsLog, serverDate, onError }: StreakSheetProps) {
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retireNote, setRetireNote] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);

  const noteLog = useStreakNotes(open && streak ? streak.slug : null, onError);

  useEffect(() => {
    if (!streak) return;
    setNotes(streak.notes || '');
    setEditing(false);
    setRetiring(false);
    setRetireNote('');
    setConfirmingRemove(false);
    // Re-arm only when the sheet switches counters — not on every poll of the
    // same one (streak object identity changes each refetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streak?.id]);

  useEffect(() => {
    if (editing) notesInputRef.current?.focus();
  }, [editing]);

  if (!open || !streak) return null;
  const s = streak;

  const linkedHabit = s.habit_key
    ? habits.flatMap((sec) => sec.items.map((it) => ({ section: sec.name, text: it.text })))
        .find((h) => habitKey(h.section, h.text) === s.habit_key) ?? null
    : null;
  const linkedDoneToday = linkedHabit ? isHabitDoneOn(habitsLog, serverDate, linkedHabit.section, linkedHabit.text) : false;

  function saveDescription() {
    actions.saveNotes(s.id, notes.trim());
    setEditing(false);
  }

  function retire() {
    actions.retire(s.id, retireNote.trim());
    onClose();
  }

  return (
    <Sheet open={open} title={`Day ${s.days} · ${s.label}`} onClose={onClose}>
      <div className={styles.meta}>Started {s.since}</div>

      <div className={styles.field}>
        {editing ? (
          <textarea
            ref={notesInputRef}
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Dosage, changes, milestones…"
            aria-label="Description"
          />
        ) : (
          <button type="button" className={styles.notesDisplay} onClick={() => setEditing(true)}>
            {s.notes ? s.notes : <span className={styles.placeholder}>No description yet — tap to add</span>}
          </button>
        )}
        {editing ? (
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveDescription}>
              Save
            </Button>
          </div>
        ) : null}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Habit</div>
        <div className={styles.habitRow}>
          <select
            className={styles.habitSelect}
            value={s.habit_key ?? ''}
            onChange={(e) => actions.setHabit(s.id, e.target.value)}
            aria-label="Linked habit"
          >
            <option value="">Not linked</option>
            {habits.map((sec) =>
              sec.items.map((it) => {
                const key = habitKey(sec.name, it.text);
                return (
                  <option key={key} value={key}>
                    {sec.name} · {it.text}
                  </option>
                );
              }),
            )}
          </select>
          {linkedHabit ? (
            <span className={linkedDoneToday ? styles.habitDone : styles.habitPending}>
              {linkedDoneToday ? '✓ done today' : 'not yet today'}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Notes</div>
        <StreakNotes
          tag={s.tag}
          notes={noteLog.notes}
          loading={noteLog.loading}
          onAppend={noteLog.append}
          appending={noteLog.appending}
          onEdit={noteLog.edit}
          onRemove={noteLog.remove}
        />
      </div>

      <div className={styles.retireZone}>
        {retiring ? (
          <div className={styles.retireForm}>
            <div className={styles.retireHint}>
              Ends the count at Day {s.days} and writes it into today’s journal. It moves to the Life Map.
            </div>
            <textarea
              className={styles.textarea}
              value={retireNote}
              onChange={(e) => setRetireNote(e.target.value)}
              placeholder="How did it end? (goes into the journal line)"
              aria-label="Retirement note"
            />
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => setRetiring(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={retire}>
                Retire at Day {s.days}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" fullWidth onClick={() => setRetiring(true)}>
            Retire day count…
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
                actions.remove(s.id);
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
