/**
 * Buy-item detail — the /inventory?buy=<name> deep-link view, replacing the
 * old /item/buy/<name> page (inventory.js renderBuyItemDetail). Same field
 * set as the modal on a full card; Back/Cancel use history.back() and a
 * rename lands on the item's new URL, exactly like the old page.
 */
import { useState } from 'react';
import { BuyItemFields } from './BuyItemFields';
import { buyFormFromItem, buyUpdatePayload } from './buyForm';
import type { UpdateBuyPayload } from './api';
import type { BuyItem } from './types';
import styles from './inventory.module.css';

export interface BuyItemDetailProps {
  /** null once data is loaded and the name matched nothing. */
  item: BuyItem | null;
  knownCategories: string[];
  onSave: (payload: UpdateBuyPayload) => Promise<void>;
  onError: (message: string) => void;
}

function goBack() {
  window.history.back();
}

export function BuyItemDetail({ item, knownCategories, onSave, onError }: BuyItemDetailProps) {
  if (!item) {
    return (
      <div style={{ padding: 20 }}>
        <button type="button" className={styles.backBtn} onClick={goBack}>
          ← Back
        </button>
        <div className={styles.notFound}>Item not found.</div>
      </div>
    );
  }
  return <BuyItemDetailForm item={item} knownCategories={knownCategories} onSave={onSave} onError={onError} />;
}

function BuyItemDetailForm({
  item,
  knownCategories,
  onSave,
  onError,
}: BuyItemDetailProps & { item: BuyItem }) {
  const [form, setForm] = useState(() => buyFormFromItem(item));
  const [saving, setSaving] = useState(false);

  async function save() {
    const newName = form.name.trim();
    if (!newName) {
      onError('Name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = buyUpdatePayload(item.name, form);
      await onSave(payload);
      if (newName !== item.name) {
        // Renames move the deep link — full navigation, like the old
        // window.location.href = '/item/buy/<new name>'.
        window.location.href = `/inventory?buy=${encodeURIComponent(newName)}`;
      } else {
        goBack();
      }
    } catch {
      setSaving(false);
      // error toast pushed upstream — stay on the page
    }
  }

  return (
    <div className={styles.detailWrap}>
      <button type="button" className={styles.backBtn} onClick={goBack}>
        ← Back
      </button>

      <div className={styles.detailCard}>
        <input
          type="text"
          className={styles.nameInput}
          style={{ marginBottom: 16 }}
          value={form.name}
          aria-label="Item name"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />

        <BuyItemFields
          form={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          knownCategories={knownCategories}
          datalistId="inv-detail-categories"
          detail
        />

        <div className={styles.footerRow} style={{ justifyContent: 'flex-end' }}>
          <div className={styles.footerRight}>
            <button type="button" className={styles.ghostBtn} onClick={goBack}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => void save()}
              disabled={saving}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
