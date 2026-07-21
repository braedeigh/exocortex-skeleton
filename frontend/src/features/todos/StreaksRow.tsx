import { useState } from 'react';
import { Button } from '../../ui';
import type { Streak } from '../habits/types';
import styles from './StreaksRow.module.css';

export interface StreaksRowProps {
  streaks: Streak[];
  onOpen: (streak: Streak) => void;
  onAdd?: (label: string, since: string) => void;
}

/** Local YYYY-MM-DD, the add form's default ("Day 0 as of today"). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * "Day N <label>" counters — active ones only (retired counters live on the
 * Life Map's Retired card). Each chip opens its detail sheet. The ghost "+"
 * chip is the add form the React port had left behind (POST /api/streaks/add):
 * tap → inline label + start-date row, quiet until asked for.
 */
export function StreaksRow({ streaks, onOpen, onAdd }: StreaksRowProps) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [since, setSince] = useState(localToday());

  if (!streaks.length && !onAdd) return null;

  function submit() {
    const text = label.trim();
    if (!text || !since || !onAdd) return;
    onAdd(text, since);
    setLabel('');
    setSince(localToday());
    setAdding(false);
  }

  return (
    <div className={styles.row}>
      {streaks.map((s) => (
        <button
          type="button"
          className={styles.chip}
          key={s.id}
          title="Notes & details"
          onClick={() => onOpen(s)}
        >
          <span className={styles.num}>Day {s.days}</span> {s.label}
        </button>
      ))}
      {onAdd && !adding ? (
        <button
          type="button"
          className={styles.addChip}
          aria-label="Add day count"
          onClick={() => setAdding(true)}
        >
          +
        </button>
      ) : null}
      {onAdd && adding ? (
        <div className={styles.addForm}>
          <input
            className={styles.addInput}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="off weed, on patches…"
            aria-label="Counter label"
            autoFocus
          />
          <input
            className={styles.addDate}
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="Started on"
          />
          <Button variant="primary" onClick={submit} disabled={!label.trim()}>
            Add
          </Button>
          <Button variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
