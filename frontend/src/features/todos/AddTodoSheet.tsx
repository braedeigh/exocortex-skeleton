import { useEffect, useRef, useState } from 'react';
import { Button, Sheet } from '../../ui';
import { BlockerPicker } from './BlockerPicker';
import { LADDER_LABELS } from './todoHelpers';
import type { AddTodoPayload } from '../../api/endpoints';
import type { TodoItem } from './types';
import styles from './AddTodoSheet.module.css';

export interface AddTodoSheetProps {
  /** Section the sheet opens preset to; null = closed. */
  section: string | null;
  /** Not-done ladder to-dos, offered as "do after" blockers. */
  candidates: TodoItem[];
  onClose: () => void;
  onAdd: (payload: AddTodoPayload) => void;
}

/**
 * Per-section "+ add" modal — port of openAddTodoModal (core.js): opens
 * preset to the bucket whose header button was tapped, with the section
 * still switchable in a picker. Trimmed to the fields the quick-add flow
 * actually used (text, description, due date); the full attribute set stays
 * one tap away in the DetailSheet after adding.
 */
export function AddTodoSheet({ section, candidates, onClose, onAdd }: AddTodoSheetProps) {
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [dueBy, setDueBy] = useState('');
  const [afterDate, setAfterDate] = useState('');
  const [afterId, setAfterId] = useState('');
  const [target, setTarget] = useState<string>(LADDER_LABELS[0]);
  const textInputRef = useRef<HTMLInputElement>(null);

  const open = section !== null;

  // Reset per open — each "+ add" starts a fresh item in the tapped section.
  useEffect(() => {
    if (section === null) return;
    setText('');
    setNotes('');
    setDueBy('');
    setAfterDate('');
    setAfterId('');
    setTarget(section);
    textInputRef.current?.focus();
  }, [section]);

  if (!open) return null;

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) {
      textInputRef.current?.focus();
      return;
    }
    onAdd({
      item: trimmed,
      section: target,
      notes: notes.trim() || undefined,
      due_by: dueBy || undefined,
      after_date: afterDate || undefined,
      after_id: afterId || undefined,
    });
    onClose();
  }

  return (
    <Sheet open={open} title={`Add to ${target}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={styles.field}>
          <input
            ref={textInputRef}
            className={styles.input}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What needs doing?"
            aria-label="To-do"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="at-section">
            Section
          </label>
          <select
            id="at-section"
            className={styles.select}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {LADDER_LABELS.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="at-due">
            Due by <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="at-due"
            className={styles.input}
            type="date"
            value={dueBy}
            onChange={(e) => setDueBy(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="at-after-date">
            Do after <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="at-after-date"
            className={styles.input}
            type="date"
            value={afterDate}
            onChange={(e) => setAfterDate(e.target.value)}
            aria-label="Do after date"
          />
          <BlockerPicker candidates={candidates} value={afterId} onChange={setAfterId} />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="at-notes">
            Description <span className={styles.optional}>(optional)</span>
          </label>
          <textarea
            id="at-notes"
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any details…"
          />
        </div>

        <div className={styles.actions}>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Add
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
