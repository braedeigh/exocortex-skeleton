import { useState } from 'react';
import { deleteCategory, renameCategory } from './api';
import { Modal } from './Modal';
import type { KitchenData } from './types';
import styles from './kitchen.module.css';

export interface CategoriesEditorModalProps {
  data: KitchenData;
  onClose: () => void;
  onError: (message: string) => void;
  invalidate: () => void;
  /** prompt-and-create a new category (shared _createKitchenCategory flow) */
  createCategoryNamed: (raw: string) => Promise<string | null>;
}

/** Port of openCategoriesEditor — rename via the field + ✓, delete via ×
 * (items reassign, prompt+confirm), add at the bottom. */
export function CategoriesEditorModal({ data, onClose, onError, invalidate, createCategoryNamed }: CategoriesEditorModalProps) {
  const order = (data.kitchen_category_order || []).slice();
  const known = data.kitchen_known_items || {};
  const itemsByCat: Record<string, number> = {};
  Object.values(known).forEach((c) => {
    itemsByCat[c] = (itemsByCat[c] || 0) + 1;
  });

  const [addName, setAddName] = useState('');

  async function rename(oldName: string, input: HTMLInputElement) {
    const newName = (input.value || '').trim().toLowerCase();
    if (!newName || newName === oldName.toLowerCase()) {
      input.value = oldName;
      return;
    }
    try {
      const res = await renameCategory(oldName, newName);
      if (res?.error) {
        onError(res.error);
        input.value = oldName;
        return;
      }
    } catch (e) {
      onError(`Rename failed: ${e instanceof Error ? e.message : e}`);
      input.value = oldName;
      return;
    }
    invalidate();
  }

  async function remove(name: string, count: number) {
    const reassign =
      count > 0
        ? (window.prompt(`Delete "${name}" — ${count} item${count === 1 ? '' : 's'} will move to which category?`, 'other') || '')
            .trim()
            .toLowerCase()
        : 'other';
    if (count > 0 && !reassign) return;
    if (!window.confirm(`Delete category "${name}"?`)) return;
    try {
      const res = await deleteCategory(name, reassign);
      if (res?.error) {
        onError(res.error);
        return;
      }
    } catch (e) {
      onError(`Delete failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    invalidate();
  }

  async function add() {
    const created = await createCategoryNamed(addName);
    if (!created) return;
    setAddName('');
    invalidate();
  }

  return (
    <Modal
      title="Manage Categories"
      onClose={onClose}
      footer={
        <>
          <input
            type="text"
            className={styles.textInput}
            style={{ flex: 1, minWidth: 0 }}
            placeholder="New category…"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
          <button type="button" className={styles.primaryBtn} onClick={() => void add()}>
            Add
          </button>
        </>
      }
    >
      <div className={styles.muted12} style={{ marginBottom: 12 }}>
        Edit name in the field then ✓ to rename. × deletes (items reassign to &quot;other&quot;). Use Edit order for
        ordering.
      </div>
      {order.map((cat) => {
        if (cat === '@aisles') {
          return (
            <div
              key={cat}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(124,92,191,0.08)',
              }}
            >
              <span style={{ flex: 1, fontSize: 13, fontStyle: 'italic', color: 'var(--text-muted)' }}>
                Aisles (1, 2, 3…) <span className={styles.muted12}>— sentinel, can&apos;t edit</span>
              </span>
            </div>
          );
        }
        const count = itemsByCat[cat] || 0;
        return (
          <div
            key={cat}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', borderBottom: '1px solid var(--border)' }}
          >
            <input
              type="text"
              className={styles.textInput}
              style={{ flex: 1, minWidth: 0, fontSize: 13 }}
              defaultValue={cat}
              aria-label={`Rename category ${cat}`}
              id={`cat-rename-${cat}`}
            />
            <span className={styles.muted12} style={{ minWidth: 50, textAlign: 'right' }}>
              {count} item{count === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className={styles.smallBtn}
              title="Save rename"
              onClick={(e) => {
                const input = (e.currentTarget.parentElement as HTMLElement).querySelector('input');
                if (input) void rename(cat, input);
              }}
            >
              ✓
            </button>
            <button
              type="button"
              className={styles.deleteBtn}
              style={{ color: 'var(--red)', fontSize: 18 }}
              title="Delete category"
              onClick={() => void remove(cat, count)}
            >
              &times;
            </button>
          </div>
        );
      })}
    </Modal>
  );
}
