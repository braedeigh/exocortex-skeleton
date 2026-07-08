import { useEffect, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import { LADDER_LABELS, TODO_CATEGORIES, TODO_STATUSES, TODO_THEMES, fmtAddedDate } from './todoHelpers';
import type { TodoDetailsPatch } from '../../api/endpoints';
import type { TodoItem } from './types';
import styles from './DetailSheet.module.css';

export interface DetailSheetProps {
  item: TodoItem | null;
  open: boolean;
  currentSection: string | null;
  onClose: () => void;
  onSave: (id: string, patch: TodoDetailsPatch, newText: string) => void;
  onMove: (id: string, toLabel: string) => void;
  onSnooze: (id: string, days: number) => void;
  onRemove: (id: string) => void;
}

export function DetailSheet({ item, open, currentSection, onClose, onSave, onMove, onSnooze, onRemove }: DetailSheetProps) {
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [dueBy, setDueBy] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [theme, setTheme] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [customSnooze, setCustomSnooze] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!item) return;
    setText(item.text);
    setNotes(item.notes || '');
    setDueBy(item.due_by || '');
    setDueTime(item.due_time || '');
    setTheme(item.theme || '');
    setCategory(item.category || '');
    setStatus(item.status || '');
    setDurationMin(item.duration_min ? String(item.duration_min) : '');
    setConfirmingRemove(false);
  }, [item]);

  if (!open || !item) return null;

  function save() {
    if (!item) return;
    onSave(
      item.id,
      {
        notes,
        due_by: dueBy,
        due_time: dueTime,
        theme,
        category,
        status,
        duration_min: durationMin ? Number(durationMin) : 0,
      },
      text.trim() || item.text,
    );
    onClose();
  }

  return (
    <Sheet open={open} title="Edit to-do" onClose={onClose}>
      <div className={styles.meta}>
        {item.created ? `Added ${fmtAddedDate(item.created)}` : null}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="td-text">
          Text
        </label>
        <input id="td-text" className={styles.input} value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="td-notes">
          Notes
        </label>
        <textarea
          id="td-notes"
          className={styles.textarea}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add a description…"
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Due</span>
        <div className={styles.row2}>
          <input
            className={styles.input}
            type="date"
            value={dueBy}
            onChange={(e) => setDueBy(e.target.value)}
            aria-label="Due date"
          />
          <input
            className={styles.input}
            type="time"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
            aria-label="Due time"
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="td-theme">
          Focus
        </label>
        <select id="td-theme" className={styles.select} value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="">🏷️ Other</option>
          {TODO_THEMES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.emoji} {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Category</span>
        <div className={styles.chips}>
          {TODO_CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.key}
              className={`${styles.chip} ${category === c.key ? styles.active : ''}`}
              onClick={() => setCategory((cur) => (cur === c.key ? '' : c.key))}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Status</span>
        <div className={styles.chips}>
          {TODO_STATUSES.map((s) => (
            <button
              type="button"
              key={s.key}
              className={`${styles.chip} ${status === s.key ? styles.active : ''}`}
              onClick={() => setStatus((cur) => (cur === s.key ? '' : s.key))}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="td-duration">
          Duration (minutes)
        </label>
        <div className={styles.chips}>
          {[15, 30, 60].map((m) => (
            <button
              type="button"
              key={m}
              className={`${styles.chip} ${durationMin === String(m) ? styles.active : ''}`}
              onClick={() => setDurationMin(String(m))}
            >
              {m}m
            </button>
          ))}
          <input
            id="td-duration"
            className={styles.input}
            style={{ width: 90 }}
            type="number"
            min={0}
            step={5}
            value={durationMin}
            onChange={(e) => setDurationMin(e.target.value)}
            placeholder="min"
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="td-move">
          Move to
        </label>
        <select
          id="td-move"
          className={styles.select}
          value={currentSection || ''}
          onChange={(e) => onMove(item.id, e.target.value)}
        >
          {LADDER_LABELS.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Snooze</span>
        <div className={styles.snoozeRow}>
          {[
            [1, '1 day'],
            [3, '3 days'],
            [7, '1 week'],
          ].map(([days, label]) => (
            <button
              type="button"
              key={label}
              className={styles.chip}
              onClick={() => onSnooze(item.id, days as number)}
            >
              {label}
            </button>
          ))}
          <div className={styles.snoozeCustom}>
            <input
              type="number"
              min={1}
              value={customSnooze}
              onChange={(e) => setCustomSnooze(e.target.value)}
              placeholder="days"
              aria-label="Custom snooze days"
            />
            <Button
              variant="secondary"
              onClick={() => {
                const n = Number(customSnooze);
                if (n > 0) onSnooze(item.id, n);
                setCustomSnooze('');
              }}
            >
              Snooze
            </Button>
          </div>
          {item.snoozed_until ? (
            <button type="button" className={styles.chip} onClick={() => onSnooze(item.id, 0)}>
              &#8617; Clear snooze
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save}>
          Save
        </Button>
      </div>

      <div className={styles.dangerZone}>
        {confirmingRemove ? (
          <div className={styles.confirmRow}>
            <span className={styles.confirmText}>Remove this to-do?</span>
            <Button variant="secondary" onClick={() => setConfirmingRemove(false)}>
              Cancel
            </Button>
            <IconButton
              danger
              aria-label="Confirm remove"
              onClick={() => {
                onRemove(item.id);
                onClose();
              }}
            >
              &times;
            </IconButton>
          </div>
        ) : (
          <Button variant="danger" fullWidth onClick={() => setConfirmingRemove(true)}>
            Remove to-do
          </Button>
        )}
      </div>
    </Sheet>
  );
}
