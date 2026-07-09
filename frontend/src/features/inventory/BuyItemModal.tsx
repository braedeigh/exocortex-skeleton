/**
 * Buy-item edit modal — opened by tapping a buy-list row (inventory.js
 * openBuyItemModal). Borderless title input up top, field grid, notes,
 * Delete (two-step confirm, via the parent) / Cancel / Save.
 */
import { useState } from 'react';
import { BuyItemFields } from './BuyItemFields';
import { buyFormFromItem, buyUpdatePayload } from './buyForm';
import { Modal } from './Modal';
import type { UpdateBuyPayload } from './api';
import type { BuyItem } from './types';
import modalStyles from './Modal.module.css';
import styles from './inventory.module.css';

export interface BuyItemModalProps {
  item: BuyItem;
  knownCategories: string[];
  onClose: () => void;
  onSave: (payload: UpdateBuyPayload) => Promise<void>;
  /** Closes the modal first, then runs the shared confirm flow (old behavior). */
  onDelete: (name: string) => void;
  onError: (message: string) => void;
}

export function BuyItemModal({ item, knownCategories, onClose, onSave, onDelete, onError }: BuyItemModalProps) {
  const [form, setForm] = useState(() => buyFormFromItem(item));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!form.name.trim()) {
      onError('Name is required');
      return;
    }
    setSaving(true);
    try {
      await onSave(buyUpdatePayload(item.name, form));
      onClose();
    } catch {
      // error toast pushed by the mutation's onError — keep the modal open
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} editor aria-label={`Edit ${item.name}`}>
      <div className={modalStyles.modalHead}>
        <input
          type="text"
          className={styles.nameInput}
          style={{ flex: 1, fontSize: 19 }}
          value={form.name}
          aria-label="Item name"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <button type="button" className={modalStyles.closeBtn} aria-label="Close" onClick={onClose}>
          &times;
        </button>
      </div>

      <BuyItemFields
        form={form}
        onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        knownCategories={knownCategories}
        datalistId="inv-buym-categories"
      />

      <div className={styles.footerRow}>
        <button
          type="button"
          className={styles.dangerOutlineBtn}
          onClick={() => {
            onClose();
            onDelete(item.name);
          }}
        >
          Delete
        </button>
        <div className={styles.footerRight}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primaryBtn} onClick={() => void save()} disabled={saving}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
