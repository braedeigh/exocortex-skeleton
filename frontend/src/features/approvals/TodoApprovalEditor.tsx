/**
 * TodoApprovalEditor — approval editor for kinds "todo"/"life_todo", the
 * reference per-kind editor (port of openTodoApproval in pending.js). Mirrors
 * the native add-to-do form: same field vocabulary (todoHelpers) as the
 * to-do feature's TodoFormSheet, commits through the native POST
 * /api/todos/add, undo removes the created item by id.
 */
import { useRef, useState } from 'react';
import { Button } from '../../ui';
import { FRONT_EMOJI, useFronts } from '../fronts/useFronts';
import { LADDER_LABELS } from '../todos/todoHelpers';
import { addTodo, removeTodo } from './api';
import { payloadRecord } from './shared';
import { buildTodoAdd, todoDraftFromPayload, todoFinalForLedger } from './todoApproval';
import type { TodoDraft } from './todoApproval';
import type { ApprovalEditorProps } from './types';
import styles from './ApprovalEditors.module.css';

export function TodoApprovalEditor({ change, busy, onApprove, onDeny }: ApprovalEditorProps) {
  const [draft, setDraft] = useState<TodoDraft>(() => todoDraftFromPayload(payloadRecord(change)));
  const [error, setError] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];

  function set<K extends keyof TodoDraft>(key: K, value: TodoDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // Unknown bucket keys pass through as a raw label (legacy behavior) — keep
  // whatever the payload said selectable rather than silently remapping it.
  const sectionOptions = (LADDER_LABELS as readonly string[]).includes(draft.sectionLabel)
    ? [...LADDER_LABELS]
    : [draft.sectionLabel, ...LADDER_LABELS];

  function submit() {
    const built = buildTodoAdd(draft);
    if (!built.ok) {
      setError(built.error);
      textRef.current?.focus();
      return;
    }
    const body = built.value;
    onApprove({
      final: todoFinalForLedger(draft),
      toastMessage: `Added “${body.item}”`,
      commit: async () => {
        const res = await addTodo(body);
        const newId = res.id;
        if (!newId) return null;
        return {
          run: async () => {
            await removeTodo(newId);
          },
        };
      },
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-todo-text">
          To-do
        </label>
        <textarea
          id="ap-todo-text"
          ref={textRef}
          className={styles.textarea}
          rows={2}
          value={draft.text}
          onChange={(e) => set('text', e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-todo-section">
          List
        </label>
        <select
          id="ap-todo-section"
          className={styles.select}
          value={draft.sectionLabel}
          onChange={(e) => set('sectionLabel', e.target.value)}
        >
          {sectionOptions.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ap-todo-due">
            Due by <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="ap-todo-due"
            className={styles.input}
            type="date"
            value={draft.dueBy}
            onChange={(e) => set('dueBy', e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ap-todo-time">
            Time <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="ap-todo-time"
            className={styles.input}
            type="time"
            value={draft.dueTime}
            onChange={(e) => set('dueTime', e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-todo-notes">
          Description <span className={styles.optional}>(optional)</span>
        </label>
        <textarea
          id="ap-todo-notes"
          className={styles.textarea}
          rows={2}
          value={draft.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Fronts</span>
        <div className={styles.chips}>
          {/* Multi-select: tapping toggles membership — a to-do can sit on
              several fronts at once (same semantics as TodoFormSheet). */}
          {fronts.map((f) => (
            <button
              type="button"
              key={f.id}
              className={`${styles.chip} ${draft.fronts.includes(f.id) ? styles.active : ''}`}
              onClick={() =>
                set(
                  'fronts',
                  draft.fronts.includes(f.id)
                    ? draft.fronts.filter((x) => x !== f.id)
                    : [...draft.fronts, f.id],
                )
              }
            >
              {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ap-todo-duration">
          Duration <span className={styles.optional}>(min)</span>
        </label>
        <input
          id="ap-todo-duration"
          className={styles.input}
          type="number"
          min={0}
          inputMode="numeric"
          value={draft.durationMin}
          onChange={(e) => set('durationMin', e.target.value)}
        />
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <Button variant="secondary" type="button" disabled={busy} onClick={onDeny}>
          Deny
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          Approve
        </Button>
      </div>
    </form>
  );
}
