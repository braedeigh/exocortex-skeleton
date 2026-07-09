import { useState } from 'react';
import { IconButton } from '../../ui';
import type { TodoItem } from './types';
import styles from './BlockerPicker.module.css';

export interface BlockerPickerProps {
  /** id for the text input, so a <label htmlFor> can point at it. */
  inputId?: string;
  /** Not-done to-dos offered as "do after" blockers. */
  candidates: TodoItem[];
  /** Selected blocker id, or '' for none. */
  value: string;
  /** Display text for the current value when it isn't in `candidates`
   * (e.g. a blocker that's since been completed). */
  selectedLabel?: string;
  onChange: (id: string) => void;
}

/**
 * Searchable "do after" blocker picker — browse OR type. A plain text input
 * that opens the full candidate list on focus; typing filters it
 * (case-insensitive substring); tapping a row selects that to-do. Once
 * selected it renders as a row with the blocker's text and a clearly visible
 * × to clear. Deliberately not a native <datalist> — those are flaky on
 * mobile PWA and can't map display text back to an id.
 */
export function BlockerPicker({ inputId, candidates, value, selectedLabel, onChange }: BlockerPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  if (value) {
    const label = selectedLabel ?? candidates.find((c) => c.id === value)?.text ?? value;
    return (
      <div className={styles.selectedRow}>
        <span className={styles.selectedText}>{label}</span>
        <IconButton aria-label={`Clear blocker ${label}`} title="Clear blocker" onClick={() => onChange('')}>
          &times;
        </IconButton>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = q ? candidates.filter((c) => c.text.toLowerCase().includes(q)) : candidates;

  function pick(id: string) {
    onChange(id);
    setQuery('');
    setOpen(false);
  }

  return (
    <div
      className={styles.wrap}
      // Close when focus leaves the whole control — but not when it moves
      // between the input and an option row.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        id={inputId}
        className={styles.input}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={query}
        placeholder="Browse or search to-dos&hellip;"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open ? (
        <div className={styles.list} role="listbox">
          {matches.length ? (
            matches.map((c) => (
              <button
                type="button"
                key={c.id}
                className={styles.option}
                role="option"
                aria-selected={false}
                // pointerdown fires before the input's blur — preventDefault
                // keeps focus put so the row can't vanish under the tap
                // (mobile Safari doesn't focus buttons, so relying on
                // relatedTarget + click alone would close the list first).
                onPointerDown={(e) => {
                  e.preventDefault();
                  pick(c.id);
                }}
                // Keyboard path: Tab to the row, Enter fires click.
                onClick={() => pick(c.id)}
              >
                {c.text}
              </button>
            ))
          ) : (
            <div className={styles.empty}>No matching to-dos</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
