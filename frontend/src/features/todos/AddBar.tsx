import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../../ui';
import { LADDER_LABELS } from './todoHelpers';
import styles from './AddBar.module.css';

export interface AddBarProps {
  onAdd: (payload: { item: string; section: string; due_by?: string }) => void;
}

export function AddBar({ onAdd }: AddBarProps) {
  const [text, setText] = useState('');
  const [section, setSection] = useState<string>('Now');
  const [showDue, setShowDue] = useState(false);
  const [dueBy, setDueBy] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd({ item: trimmed, section, due_by: showDue && dueBy ? dueBy : undefined });
    setText('');
    setDueBy('');
    setShowDue(false);
  }

  return (
    <form className={styles.bar} onSubmit={submit}>
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
        className={`${styles.dateToggle} ${showDue ? styles.active : ''}`}
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
      <Button type="submit">Add</Button>
    </form>
  );
}
