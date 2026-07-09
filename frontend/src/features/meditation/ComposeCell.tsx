import { forwardRef, useEffect, useRef, useState } from 'react';
import { MED_TYPE_LABELS, MED_TYPE_ORDER, medTypeLabel } from './practiceHelpers';
import styles from './ComposeCell.module.css';

export interface ComposeCellProps {
  /** '' means "default to today" — shown as todayStr in the date input. */
  date: string;
  todayStr: string;
  duration: string;
  notes: string;
  selectedTypes: Set<string>;
  /** Non-builtin tag slugs (from existing entries + this session). */
  customTypes: string[];
  onDateChange: (v: string) => void;
  onDurationChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onToggleType: (t: string) => void;
  /** Raw text from the "+ tag" input; the page slugs + selects it. */
  onAddCustomType: (raw: string) => void;
  onSave: () => void;
  onClear: () => void;
}

/**
 * The compose cell at the top of the Practice stream — port of the form in
 * renderMeditationStream(). All state lives in MeditationPage (the old
 * window._medCompose survived re-renders the same way), so the timer's
 * Stop can prefill the tag + duration. The "+ tag" chip swaps to an inline
 * input instead of window.prompt (house rule, see shell/NewSessionDialog).
 * The forwarded ref targets the notes textarea so Stop can focus it.
 */
export const ComposeCell = forwardRef<HTMLTextAreaElement, ComposeCellProps>(function ComposeCell(
  {
    date,
    todayStr,
    duration,
    notes,
    selectedTypes,
    customTypes,
    onDateChange,
    onDurationChange,
    onNotesChange,
    onToggleType,
    onAddCustomType,
    onSave,
    onClear,
  },
  notesRef,
) {
  const [tagOpen, setTagOpen] = useState(false);
  const [tagName, setTagName] = useState('');
  const tagRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tagOpen) tagRef.current?.focus();
  }, [tagOpen]);

  function addTag() {
    if (tagName.trim()) onAddCustomType(tagName);
    setTagOpen(false);
    setTagName('');
  }

  const chip = (t: string, label: string) => {
    const active = selectedTypes.has(t);
    return (
      <button
        key={t}
        type="button"
        className={`${styles.tagChip} ${active ? styles.tagChipActive : ''}`}
        aria-pressed={active}
        onClick={() => onToggleType(t)}
      >
        {label}
      </button>
    );
  };

  return (
    <div className={styles.card}>
      <div className={styles.metaRow}>
        <input
          type="date"
          className={styles.dateInput}
          value={date || todayStr}
          onChange={(e) => onDateChange(e.target.value)}
          aria-label="Cell date"
        />
        <input
          type="number"
          min={1}
          placeholder="min"
          className={styles.durationInput}
          value={duration}
          onChange={(e) => onDurationChange(e.target.value)}
          aria-label="Duration in minutes"
        />
        <span className={styles.metaHint}>duration (optional)</span>
      </div>

      <div className={styles.tagRow}>
        {MED_TYPE_ORDER.map((t) => chip(t, MED_TYPE_LABELS[t]))}
        {customTypes.map((t) => chip(t, medTypeLabel(t)))}
        {tagOpen ? (
          <span className={styles.tagInputRow}>
            <input
              ref={tagRef}
              className={styles.tagInput}
              value={tagName}
              onChange={(e) => setTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTag();
                if (e.key === 'Escape') {
                  setTagOpen(false);
                  setTagName('');
                }
              }}
              placeholder="Custom tag (e.g. tonglen)"
            />
            <button type="button" className={styles.tagChip} onClick={addTag}>
              Add
            </button>
          </span>
        ) : (
          <button type="button" className={styles.tagChipDashed} onClick={() => setTagOpen(true)}>
            + tag
          </button>
        )}
      </div>

      <textarea
        ref={notesRef}
        className={styles.notes}
        rows={4}
        placeholder="What arose? What's loosening? Or just a dharma note."
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
      />

      <div className={styles.actions}>
        <button type="button" className={styles.saveBtn} onClick={onSave}>
          Add cell
        </button>
        <button type="button" className={styles.clearBtn} onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
});
