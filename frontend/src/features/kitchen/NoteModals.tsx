import { useState } from 'react';
import { capitalize } from './catalogHelpers';
import { Modal } from './Modal';
import styles from './kitchen.module.css';

/** Port of the grocery-note overlay — a one-line note on a LIST item
 * (amount, brand, where to buy). Enter saves, Escape closes. */
export function GroceryNoteModal({
  name,
  initial,
  onSave,
  onClose,
}: {
  name: string;
  initial: string;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);

  function save() {
    onSave(value);
    onClose();
  }

  return (
    <Modal
      title={`Note for ${name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.mutedBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primaryBtn} style={{ marginLeft: 'auto' }} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className={styles.muted12} style={{ marginBottom: 10 }}>
        e.g. amount, brand, where to buy
      </div>
      <input
        type="text"
        className={styles.textInput}
        style={{ width: '100%' }}
        autoFocus
        value={value}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
        }}
      />
    </Modal>
  );
}

/** Port of the item-note overlay — the long-press/right-click note on a
 * CATALOG chip (reactions, inflammation, where to buy…). */
export function ItemNoteModal({
  name,
  category,
  initial,
  onSave,
  onClose,
}: {
  name: string;
  category: string;
  initial: string;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <Modal
      title={capitalize(name)}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className={styles.primaryBtn}
            style={{ flex: 1 }}
            onClick={() => {
              onSave(value.trim());
              onClose();
            }}
          >
            Save
          </button>
          <button type="button" className={styles.mutedBtn} style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className={styles.muted12} style={{ marginBottom: 8 }}>
        Category: {category}
      </div>
      <textarea
        className={styles.textarea}
        style={{ width: '100%', minHeight: 100 }}
        placeholder="Notes — reactions, inflammation, where to buy, etc."
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </Modal>
  );
}
