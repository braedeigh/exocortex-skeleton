import { useEffect, useRef, useState } from 'react';
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

const SNOOZE_DAYS = [1, 2, 3, 4, 5, 6];
const SNOOZE_WEEKS = [1, 2, 3, 4];

export function DetailSheet({ item, open, currentSection, onClose, onSave, onMove, onSnooze, onRemove }: DetailSheetProps) {
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [dueBy, setDueBy] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [theme, setTheme] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);

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
    setMoreOpen(false);
    setEditingTitle(false);
    setEditingNotes(false);
  }, [item]);

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  useEffect(() => {
    if (editingNotes) notesInputRef.current?.focus();
  }, [editingNotes]);

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

  function pickCategory(key: string) {
    if (!item) return;
    const next = category === key ? '' : key;
    setCategory(next);
    // Category is a one-tap, immediately-committed change — it doesn't wait
    // for the Save button, and deliberately doesn't touch the title so an
    // in-progress (unsaved) title edit isn't force-committed as a side effect.
    onSave(item.id, { category: next }, item.text);
  }

  return (
    <Sheet open={open} title="Edit to-do" onClose={onClose}>
      <div className={styles.meta}>
        {item.created ? `Added ${fmtAddedDate(item.created)}` : null}
      </div>

      <div className={styles.field}>
        {editingTitle ? (
          <input
            id="td-text"
            ref={titleInputRef}
            className={`${styles.input} ${styles.titleInput}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setEditingTitle(false);
              }
            }}
            aria-label="Text"
          />
        ) : (
          <button type="button" className={styles.titleDisplay} onClick={() => setEditingTitle(true)}>
            {text || 'Untitled'}
          </button>
        )}
      </div>

      <div className={styles.field}>
        {editingNotes ? (
          <textarea
            id="td-notes"
            ref={notesInputRef}
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => setEditingNotes(false)}
            placeholder="Add a description…"
            aria-label="Notes"
          />
        ) : (
          <button type="button" className={styles.notesDisplay} onClick={() => setEditingNotes(true)}>
            {notes ? notes : <span className={styles.placeholder}>Add a description…</span>}
          </button>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Category</span>
        <div className={styles.chips}>
          {TODO_CATEGORIES.map((c) => (
            <button
              type="button"
              key={c.key}
              className={`${styles.chip} ${category === c.key ? styles.active : ''}`}
              onClick={() => pickCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className={styles.moreToggle}
        onClick={() => setMoreOpen((v) => !v)}
        aria-expanded={moreOpen}
      >
        <span className={`${styles.moreArrow} ${moreOpen ? styles.moreArrowOpen : ''}`} aria-hidden="true">
          &#9654;
        </span>
        {moreOpen ? 'Fewer options' : 'More options'}
      </button>

      {moreOpen ? (
        <>
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
            {dueBy ? (
              <button
                type="button"
                className={styles.chip}
                onClick={() => {
                  setDueBy('');
                  setDueTime('');
                }}
              >
                &#8617; Remove date
              </button>
            ) : null}
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
              {SNOOZE_DAYS.map((d) => (
                <button type="button" key={`d${d}`} className={styles.chip} onClick={() => onSnooze(item.id, d)}>
                  {d}d
                </button>
              ))}
            </div>
            <div className={styles.snoozeRow}>
              {SNOOZE_WEEKS.map((w) => (
                <button
                  type="button"
                  key={`w${w}`}
                  className={styles.chip}
                  onClick={() => onSnooze(item.id, w * 7)}
                >
                  {w}w
                </button>
              ))}
            </div>
            {item.snoozed_until ? (
              <button type="button" className={styles.chip} onClick={() => onSnooze(item.id, 0)}>
                &#8617; Clear snooze
              </button>
            ) : null}
          </div>
        </>
      ) : null}

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
