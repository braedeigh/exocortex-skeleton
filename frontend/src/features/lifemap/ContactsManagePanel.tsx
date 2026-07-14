import { useState } from 'react';
import { CONTACT_METHODS, capitalize, contactStatus } from './contactMath';
import type { Contact } from './types';
import styles from './ContactsCard.module.css';

export interface ContactsManagePanelProps {
  contacts: Contact[];
  onLog: (name: string, method: string) => void;
  onMove: (name: string, dir: -1 | 1) => void;
  onUpdateThreshold: (name: string, days: number) => void;
  onRemove: (name: string) => void;
  onAdd: (name: string, threshold: number) => Promise<unknown>;
}

/**
 * "Manage contacts" panel body — port of contacts.js manageContactsPanelHtml:
 * the keep-in-touch grid (status color, last method, per-contact cadence,
 * quick method log, reorder, remove) + the add-person form.
 */
export function ContactsManagePanel({
  contacts,
  onLog,
  onMove,
  onUpdateThreshold,
  onRemove,
  onAdd,
}: ContactsManagePanelProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addThreshold, setAddThreshold] = useState('14');

  async function submitAdd() {
    const name = addName.trim();
    if (!name) return;
    const threshold = Math.max(1, Number(addThreshold) || 14);
    try {
      await onAdd(name, threshold);
      setAddName('');
      setAddThreshold('14');
    } catch {
      // error toast raised by the mutation (old code alert()ed)
    }
  }

  function removeWithConfirm(name: string) {
    // Same affordance the old removeContact used (browser confirm()).
    if (!confirm(`Remove ${name}?`)) return;
    onRemove(name);
  }

  return (
    <div>
      <div className={styles.grid}>
        {contacts.map((c) => {
          const { color, statusText } = contactStatus(c);
          return (
            <div key={c.name} className={styles.card}>
              <button
                type="button"
                className={styles.remove}
                title="Remove"
                onClick={() => removeWithConfirm(c.name)}
              >
                &times;
              </button>
              <div className={styles.reorderBtns}>
                <button type="button" className={styles.reorderBtn} title="Move up" onClick={() => onMove(c.name, -1)}>
                  &#9650;
                </button>
                <button
                  type="button"
                  className={styles.reorderBtn}
                  title="Move down"
                  onClick={() => onMove(c.name, 1)}
                >
                  &#9660;
                </button>
              </div>
              {/* Status color rides the name text (the old colored left border is gone). */}
              <div className={styles.name} style={{ color }}>
                {c.name}
              </div>
              <div className={styles.status} style={{ color }}>
                {statusText}
              </div>
              {c.method ? <div className={styles.method}>Last: {capitalize(c.method)}</div> : null}
              <div className={styles.cadence}>
                remind every
                {/* Commit on change/blur like the old onchange handler — not
                    per keystroke. Keyed so a server-side edit re-syncs it. */}
                <input
                  key={`${c.name}:${c.threshold_days}`}
                  type="number"
                  min={1}
                  className={styles.cadenceInput}
                  defaultValue={c.threshold_days}
                  onBlur={(e) => {
                    const days = Number(e.target.value);
                    if (!days || days < 1 || days === c.threshold_days) {
                      e.target.value = String(c.threshold_days);
                      return;
                    }
                    onUpdateThreshold(c.name, days);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
                days
              </div>
              <div className={styles.actionsRow}>
                {CONTACT_METHODS.map((m) => (
                  <button key={m} type="button" onClick={() => onLog(c.name, m.toLowerCase())}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <button type="button" className={styles.addTrigger} onClick={() => setAddOpen((v) => !v)}>
        + Add person
      </button>
      {addOpen ? (
        <div className={styles.addForm}>
          <input
            type="text"
            placeholder="Name..."
            value={addName}
            autoFocus
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitAdd();
            }}
          />
          <span className={styles.addLabel}>remind every</span>
          <input
            type="number"
            min={1}
            value={addThreshold}
            onChange={(e) => setAddThreshold(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitAdd();
            }}
          />
          <span className={styles.addLabel}>days</span>
          <button type="button" onClick={() => void submitAdd()}>
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}
