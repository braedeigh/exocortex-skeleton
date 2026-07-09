import { useEffect, useRef, useState } from 'react';
import styles from './HabitTrackerCard.module.css';

/** "+ Add" trigger that expands into an input + Add button (core.js
 * toggleAdd / .add-form idiom). Clears + collapses on submit. */
export function AddForm({
  triggerLabel,
  placeholder,
  onAdd,
  indent = false,
}: {
  triggerLabel: string;
  placeholder: string;
  onAdd: (text: string) => void;
  indent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  function submit() {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText('');
    setOpen(false);
  }

  return (
    <div style={indent ? { marginLeft: 24 } : undefined}>
      <button type="button" className={styles.addTrigger} onClick={() => setOpen((v) => !v)}>
        {triggerLabel}
      </button>
      {open ? (
        <div className={styles.addForm}>
          <input
            type="text"
            placeholder={placeholder}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button type="button" onClick={submit}>
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Move-to-section popover (habits.js showTrackerMoveMenu). */
export function MoveMenu({
  label,
  title,
  current,
  targets,
  onMove,
}: {
  label: string;
  title: string;
  current: string;
  targets: string[];
  onMove: (toSection: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <span className={styles.moveMenuWrap} ref={wrapRef}>
      <button type="button" className={styles.smallBtn} title={title} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open ? (
        <div className={styles.moveMenu}>
          {targets
            .filter((s) => s !== current)
            .map((s) => (
              <button
                key={s}
                type="button"
                className={styles.moveMenuItem}
                onClick={() => {
                  setOpen(false);
                  onMove(s);
                }}
              >
                {s}
              </button>
            ))}
        </div>
      ) : null}
    </span>
  );
}

/** Click-to-rename text (habits.js startTrackerRename): the span becomes an
 * input; Enter/blur commits, Escape cancels. */
export function RenameText({
  value,
  strike = false,
  title = 'Click to rename',
  onRename,
}: {
  value: string;
  strike?: boolean;
  title?: string;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <span
        style={{
          cursor: 'text',
          flex: 1,
          minWidth: 0,
          ...(strike ? { textDecoration: 'line-through', opacity: 0.5 } : {}),
        }}
        title={title}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </span>
    );
  }

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === value) return;
    onRename(next);
  }

  return (
    <input
      className={styles.renameInput}
      value={draft}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}
