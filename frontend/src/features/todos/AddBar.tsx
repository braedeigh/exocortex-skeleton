import { useRef, useState } from 'react';
import type { FocusEvent, FormEvent } from 'react';
import { Button } from '../../ui';
import { frontLabel } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import { LADDER_LABELS } from './todoHelpers';
import styles from './AddBar.module.css';

export interface AddBarProps {
  onAdd: (payload: { item: string; section: string; due_by?: string }) => void;
  /** Active focus filter — the page stamps it onto the add, so show it. */
  focusFront?: string;
  fronts: Front[];
}

/**
 * Inline quick-add — the text field spans the full column width on its own
 * row; the section/due controls only appear below it once the field is
 * focused or has text in it, rather than sitting there permanently (dev note
 * 3621915a). Collapses back once it's blurred with nothing typed.
 */
export function AddBar({ onAdd, focusFront, fronts }: AddBarProps) {
  const [text, setText] = useState('');
  const [section, setSection] = useState<string>('Now');
  const [showDue, setShowDue] = useState(false);
  const [dueBy, setDueBy] = useState('');
  const [focused, setFocused] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const expanded = focused || text.trim().length > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd({
      item: trimmed,
      section,
      due_by: showDue && dueBy ? dueBy : undefined,
    });
    setText('');
    setDueBy('');
    setShowDue(false);
    setFocused(false);
  }

  function handleBlur(e: FocusEvent<HTMLFormElement>) {
    // Collapse only once focus has left the whole form (a tap on the select/
    // date controls below blurs the input first, but the new target is
    // still inside formRef) — and only if there's nothing typed.
    if (!formRef.current?.contains(e.relatedTarget as Node | null)) {
      setFocused(false);
    }
  }

  return (
    <form ref={formRef} className={styles.bar} onSubmit={submit} onBlur={handleBlur}>
      {/* Single-line field — Enter already submits the form natively (no
          textarea/multiline mode here, so there's no Shift+Enter case to
          handle). Add sits on the same line as the field once it's active;
          the section/due details stay on the row below. */}
      <div className={styles.topRow}>
        <input
          className={styles.input}
          type="text"
          placeholder={
            focusFront && focusFront !== '__none__'
              ? `Add a to-do… → ${frontLabel(fronts, focusFront)}`
              : 'Add a to-do…'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
        />
        {expanded ? <Button type="submit">Add</Button> : null}
      </div>
      {expanded ? (
        <div className={styles.extra}>
          <select className={styles.select} value={section} onChange={(e) => setSection(e.target.value)}>
            {LADDER_LABELS.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`${styles.iconToggle} ${showDue ? styles.active : ''}`}
            onClick={() => setShowDue((v) => !v)}
            title="Due date"
          >
            📅
          </button>
          {showDue ? (
            <input
              className={styles.date}
              type="date"
              value={dueBy}
              onChange={(e) => setDueBy(e.target.value)}
            />
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
