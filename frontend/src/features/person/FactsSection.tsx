import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { RESERVED_FACT_KEYS, buildFactsPayload, capitalizeKey, factRows } from './personLogic';
import { useSaveFacts } from './usePersonData';
import styles from './FactsSection.module.css';

export interface FactsSectionProps {
  slug: string;
  facts: Record<string, string>;
  onError: (message: string) => void;
}

/**
 * Inline-editable key/value facts (port of person.js renderFacts): the four
 * seed fields always show ("add…" when empty), extra facts follow, tapping a
 * row swaps it for an input, and "+ add fact" grows a key+value pair. A
 * commit POSTs the *whole* facts map (buildFactsPayload) and re-renders from
 * the server's re-serialized copy. Commits on Enter, the ✓ button, or blur
 * away from the row; Escape / × cancels.
 */
export function FactsSection({ slug, facts, onError }: FactsSectionProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addValue, setAddValue] = useState('');
  // Set when an editor is being closed deliberately (Escape / ×) so the
  // blur that follows doesn't also commit.
  const skipBlurRef = useRef(false);

  const editInputRef = useRef<HTMLInputElement | null>(null);
  const addKeyInputRef = useRef<HTMLInputElement | null>(null);

  const save = useSaveFacts(slug, onError);
  const saving = save.isPending;

  useEffect(() => {
    if (editingKey !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingKey]);

  useEffect(() => {
    if (adding) addKeyInputRef.current?.focus();
  }, [adding]);

  function closeEditors() {
    setEditingKey(null);
    setAdding(false);
    setAddKey('');
    setAddValue('');
  }

  function cancelEditors() {
    skipBlurRef.current = true;
    closeEditors();
  }

  function openEdit(key: string, value: string) {
    skipBlurRef.current = false;
    setAdding(false);
    setEditingKey(key);
    setEditValue(value);
  }

  function openAdd() {
    skipBlurRef.current = false;
    setEditingKey(null);
    setAdding(true);
    setAddKey('');
    setAddValue('');
  }

  function commit(edits: Record<string, string>, onSaved: () => void) {
    if (saving) return;
    save.mutate(buildFactsPayload(facts, edits), { onSuccess: onSaved });
  }

  function commitEdit() {
    if (editingKey === null) return;
    const key = editingKey;
    // Close only the editor that committed — if she's already opened a
    // different row while this save was in flight, leave that one alone.
    commit({ [key]: editValue }, () => setEditingKey((cur) => (cur === key ? null : cur)));
  }

  /** True when the add row holds a committable fact; toasts and returns false otherwise. */
  function commitAdd(): boolean {
    const newKey = addKey.trim().toLowerCase();
    if (!newKey) return false;
    if (RESERVED_FACT_KEYS.has(newKey)) {
      onError(`"${newKey}" is a reserved key`);
      return false;
    }
    commit({ [newKey]: addValue.trim() }, () => {
      setAdding(false);
      setAddKey('');
      setAddValue('');
    });
    return true;
  }

  /** Shared "did focus leave this row?" check for the blur-commit behavior. */
  function blurLeftRow(e: FocusEvent<HTMLDivElement>): boolean {
    if (skipBlurRef.current) return false;
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return false;
    return true;
  }

  function onEditBlur(e: FocusEvent<HTMLDivElement>) {
    if (blurLeftRow(e)) commitEdit();
  }

  function onAddBlur(e: FocusEvent<HTMLDivElement>) {
    if (!blurLeftRow(e)) return;
    // Nothing typed (or a rejected key) -> just fold the row back up.
    if (!commitAdd()) cancelEditors();
  }

  function onEditKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEditors();
  }

  function onAddValueKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      if (!commitAdd()) addKeyInputRef.current?.focus();
    }
    if (e.key === 'Escape') cancelEditors();
  }

  function onAddKeyKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') cancelEditors();
  }

  return (
    <div>
      {factRows(facts).map(({ key, value }) =>
        editingKey === key ? (
          <div key={key} className={styles.rowEditing} onBlur={onEditBlur}>
            <span className={styles.label}>{capitalizeKey(key)}</span>
            <input
              ref={editInputRef}
              className={styles.input}
              value={editValue}
              placeholder="add…"
              disabled={saving}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={onEditKeyDown}
            />
            <button type="button" className={styles.btn} title="Save" disabled={saving} onClick={commitEdit}>
              ✓
            </button>
            <button type="button" className={styles.btn} title="Cancel" disabled={saving} onClick={cancelEditors}>
              ×
            </button>
          </div>
        ) : (
          <div
            key={key}
            className={styles.row}
            role="button"
            tabIndex={0}
            onClick={() => openEdit(key, value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openEdit(key, value);
              }
            }}
          >
            <span className={styles.label}>{capitalizeKey(key)}</span>
            {value ? <span className={styles.value}>{value}</span> : <span className={styles.placeholder}>add…</span>}
          </div>
        ),
      )}

      {adding ? (
        <div className={styles.addRow} onBlur={onAddBlur}>
          <input
            ref={addKeyInputRef}
            className={styles.keyInput}
            value={addKey}
            placeholder="field name"
            disabled={saving}
            onChange={(e) => setAddKey(e.target.value)}
            onKeyDown={onAddKeyKeyDown}
          />
          <input
            className={styles.input}
            value={addValue}
            placeholder="value"
            disabled={saving}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={onAddValueKeyDown}
          />
          <button
            type="button"
            className={styles.btn}
            title="Save"
            disabled={saving}
            onClick={() => {
              if (!commitAdd()) addKeyInputRef.current?.focus();
            }}
          >
            ✓
          </button>
          <button type="button" className={styles.btn} title="Cancel" disabled={saving} onClick={cancelEditors}>
            ×
          </button>
        </div>
      ) : (
        <div className={styles.addRow}>
          <button type="button" className={styles.addBtn} onClick={openAdd}>
            + add fact
          </button>
        </div>
      )}
    </div>
  );
}
