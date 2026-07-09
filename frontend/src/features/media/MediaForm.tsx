import { useState } from 'react';
import type { MediaItemFields } from './api';
import { mediaTypeLabel, todayStr } from './mediaHelpers';
import { MEDIA_TYPES } from './types';
import type { MediaItem } from './types';
import styles from './MediaForm.module.css';

export interface MediaFormProps {
  /** 'compose' = the always-visible add card (Add/Clear); 'edit' = the
   * accent-bordered inline editor replacing a card (Save/Cancel). */
  variant: 'compose' | 'edit';
  /** Edit only — the item being edited seeds the fields. */
  initial?: MediaItem;
  /** Compose only — sticky type chip selection (old window._mediaCompose.type). */
  initialType?: string;
  onTypeChange?: (type: string) => void;
  onSubmit: (fields: MediaItemFields) => void;
  /** Edit only — Cancel button. */
  onCancel?: () => void;
  /** Validation feedback (old code used alert()). */
  onInvalid: (message: string) => void;
}

/**
 * Shared compose/edit form — port of media.js's compose card and
 * _mediaRenderEditor, which were the same fields with different chrome:
 * type chips, title, author, recommended-by, date (defaults to today),
 * notes, then Add/Clear or Save/Cancel.
 */
export function MediaForm({
  variant,
  initial,
  initialType,
  onTypeChange,
  onSubmit,
  onCancel,
  onInvalid,
}: MediaFormProps) {
  const [type, setType] = useState(initial?.type || initialType || 'book');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [author, setAuthor] = useState(initial?.author ?? '');
  const [recommendedBy, setRecommendedBy] = useState(initial?.recommended_by ?? '');
  const [date, setDate] = useState(initial?.date || todayStr());
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const isEdit = variant === 'edit';

  function pickType(t: string) {
    setType(t);
    onTypeChange?.(t);
  }

  // Old _mediaClearCompose: clears the text fields, keeps type and date.
  function clearFields() {
    setTitle('');
    setAuthor('');
    setRecommendedBy('');
    setNotes('');
  }

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) {
      onInvalid(isEdit ? 'Title cannot be empty.' : 'Add a title first.');
      return;
    }
    onSubmit({
      title: trimmed,
      type,
      author: author.trim(),
      recommended_by: recommendedBy.trim(),
      date: date || todayStr(),
      notes: notes.trim(),
    });
    if (!isEdit) clearFields();
  }

  return (
    <div className={`${styles.form} ${isEdit ? styles.editing : ''}`}>
      <div className={styles.chipRow}>
        {MEDIA_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.typeChip} ${t === type ? styles.typeChipActive : ''}`}
            onClick={() => pickType(t)}
          >
            {mediaTypeLabel(t)}
          </button>
        ))}
      </div>
      <input
        type="text"
        className={`${styles.input} ${styles.titleInput}`}
        placeholder={isEdit ? 'Title' : 'Title (book, movie, show…)'}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className={styles.fieldRow}>
        <input
          type="text"
          className={`${styles.input} ${styles.grow}`}
          placeholder="Author (books)"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
        />
        <input
          type="text"
          className={`${styles.input} ${styles.grow}`}
          placeholder="Recommended by (optional)"
          value={recommendedBy}
          onChange={(e) => setRecommendedBy(e.target.value)}
        />
        <input
          type="date"
          className={styles.input}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <textarea
        className={`${styles.input} ${styles.notes}`}
        rows={3}
        placeholder={
          isEdit
            ? 'Notes'
            : "Notes — why it was recommended, what it's about, where to find it…"
        }
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className={styles.buttonRow}>
        <button type="button" className={styles.submitBtn} onClick={submit}>
          {isEdit ? 'Save' : 'Add'}
        </button>
        {isEdit ? (
          <button type="button" className={styles.ghostBtn} onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className={styles.ghostBtn} onClick={clearFields}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
