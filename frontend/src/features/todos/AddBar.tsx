import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../../ui';
import { LADDER_LABELS, TODO_CATEGORIES, categoryLabel } from './todoHelpers';
import styles from './AddBar.module.css';

export interface AddBarProps {
  onAdd: (payload: { item: string; section: string; due_by?: string; category?: string }) => void;
}

export function AddBar({ onAdd }: AddBarProps) {
  const [text, setText] = useState('');
  const [section, setSection] = useState<string>('Now');
  const [showDue, setShowDue] = useState(false);
  const [dueBy, setDueBy] = useState('');
  const [category, setCategory] = useState('');
  const [showCategory, setShowCategory] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd({
      item: trimmed,
      section,
      due_by: showDue && dueBy ? dueBy : undefined,
      category: category || undefined,
    });
    setText('');
    setDueBy('');
    setShowDue(false);
    setCategory('');
    setShowCategory(false);
  }

  return (
    <form className={styles.bar} onSubmit={submit}>
      {/* Single-line field — Enter already submits the form natively (no
          textarea/multiline mode here, so there's no Shift+Enter case to
          handle). */}
      <input
        className={styles.input}
        type="text"
        placeholder="Add a to-do…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <select className={styles.select} value={section} onChange={(e) => setSection(e.target.value)}>
        {LADDER_LABELS.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`${styles.iconToggle} ${category ? styles.active : ''}`}
        onClick={() => setShowCategory((v) => !v)}
        title="Category"
        aria-label={category ? `Category: ${categoryLabel(category)}` : 'Set category'}
      >
        🏷️
      </button>
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
      {showCategory ? (
        <div className={styles.categoryRow}>
          {TODO_CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.key}
              className={`${styles.categoryChip} ${category === c.key ? styles.active : ''}`}
              onClick={() => {
                setCategory((cur) => (cur === c.key ? '' : c.key));
                setShowCategory(false);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      <Button type="submit">Add</Button>
    </form>
  );
}
