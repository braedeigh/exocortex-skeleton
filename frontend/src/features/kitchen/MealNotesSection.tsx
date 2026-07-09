import { useState } from 'react';
import { addMealNote } from './api';
import { Section } from './Section';
import type { MealNote } from './types';
import styles from './kitchen.module.css';

export interface MealNotesSectionProps {
  notes: MealNote[];
  invalidate: () => void;
  onError: (message: string) => void;
  /** two-step confirm; deletes by index into the full list */
  onConfirmDelete: (index: number, note: MealNote) => void;
}

function noteDateLabel(date: string): string {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Port of the Meal Notes card — textarea (Enter saves), last 3 shown, the
 * rest behind an "older notes" disclosure, delete-with-confirm. */
export function MealNotesSection({ notes, invalidate, onError, onConfirmDelete }: MealNotesSectionProps) {
  const [text, setText] = useState('');

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await addMealNote(trimmed);
    } catch (e) {
      onError(`Couldn't save note: ${e instanceof Error ? e.message : e}`);
      return;
    }
    setText('');
    invalidate();
  }

  const showNotes = notes.slice(0, 3);
  const moreNotes = notes.slice(3);

  const noteCard = (note: MealNote, index: number, older: boolean) => (
    <div
      key={`${note.date}-${index}`}
      style={{
        background: 'var(--card-bg)',
        borderRadius: 8,
        padding: '12px 16px',
        marginBottom: 8,
        borderLeft: `3px solid ${older ? 'var(--border)' : 'var(--accent)'}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span className={styles.muted12}>{noteDateLabel(note.date)}</span>
        <button
          type="button"
          className={styles.deleteBtn}
          style={{ fontSize: 16, opacity: 0.6 }}
          title="Delete"
          onClick={() => onConfirmDelete(index, note)}
        >
          &times;
        </button>
      </div>
      <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{note.text}</div>
    </div>
  );

  return (
    <Section title="Meal Notes" badge={notes.length ? <span className={styles.muted13}>({notes.length})</span> : undefined}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <textarea
          className={styles.textarea}
          style={{ flex: 1, minHeight: 60 }}
          placeholder="Meal idea, recipe note, what you liked/disliked..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <button type="button" className={styles.primaryBtn} style={{ alignSelf: 'flex-end' }} onClick={() => void save()}>
          Save
        </button>
      </div>

      {showNotes.map((n, i) => noteCard(n, i, false))}

      {moreNotes.length ? (
        <details>
          <summary style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'var(--text-muted)', minHeight: 40, display: 'flex', alignItems: 'center' }}>
            {moreNotes.length} older notes
          </summary>
          <div style={{ marginTop: 8 }}>{moreNotes.map((n, i) => noteCard(n, i + 3, true))}</div>
        </details>
      ) : null}

      {!notes.length ? (
        <div className={styles.muted13}>Jot down meal ideas, recipe notes, or what you liked about a meal.</div>
      ) : null}
    </Section>
  );
}
