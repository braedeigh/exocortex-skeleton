import { useState } from 'react';
import { addCatalogItem, renameCatalogItem, setSafetyTag } from './api';
import { capitalize, kitchenCats } from './catalogHelpers';
import { Modal } from './Modal';
import type { KitchenData } from './types';
import styles from './kitchen.module.css';

const NEW_CAT = '__new__';

export interface CatalogEditorModalProps {
  data: KitchenData;
  onClose: () => void;
  onError: (message: string) => void;
  /** loadDashboard() stand-in */
  invalidate: () => void;
  /** two-step confirm for the × delete */
  onConfirmDelete: (name: string) => void;
  onManageCategories: () => void;
  /** set an item's category (optimistic-ish; POST /api/kitchen/catalog/add) */
  onSetCategory: (name: string, category: string) => void;
  /** prompt-and-create a new category; resolves the normalized name or null */
  createCategory: () => Promise<string | null>;
}

/** Port of openCatalogEditor — rename inputs (save on blur/Enter), category
 * selects with "+ New category…", safe/suspect toggles, delete, add row. */
export function CatalogEditorModal({
  data,
  onClose,
  onError,
  invalidate,
  onConfirmDelete,
  onManageCategories,
  onSetCategory,
  createCategory,
}: CatalogEditorModalProps) {
  const known = data.kitchen_known_items || {};
  const safetyTags = data.kitchen_safety_tags || {};
  const { categoryOrder, categoryLabels } = kitchenCats(
    (data.kitchen_category_order || []).filter((c) => c !== '@aisles'),
  );
  const items = Object.entries(known).sort((a, b) => a[0].localeCompare(b[0]));

  const [newName, setNewName] = useState('');
  const [newCat, setNewCat] = useState(categoryOrder[0] || 'other');

  async function saveRename(orig: string, value: string, reset: () => void) {
    const newNameTrim = value.trim();
    if (!newNameTrim) {
      reset();
      return;
    }
    if (newNameTrim.toLowerCase() === orig.toLowerCase()) return;
    try {
      const res = await renameCatalogItem(orig, newNameTrim);
      if (res?.error) {
        onError(res.error);
        reset();
        return;
      }
    } catch (e) {
      onError(`Rename failed: ${e instanceof Error ? e.message : e}`);
      reset();
      return;
    }
    invalidate();
  }

  async function toggleSafety(name: string, tag: 'safe' | 'suspect') {
    const current = safetyTags[name] || '';
    const next = current === tag ? '' : tag;
    try {
      await setSafetyTag(name, next);
    } catch (e) {
      onError(`Couldn't save tag: ${e instanceof Error ? e.message : e}`);
    }
    invalidate();
  }

  async function addItem() {
    const name = newName.trim();
    if (!name) return;
    try {
      await addCatalogItem(name, newCat);
    } catch (e) {
      onError(`Couldn't add: ${e instanceof Error ? e.message : e}`);
    }
    setNewName('');
    invalidate();
  }

  async function selectCategory(name: string, value: string, resetSelect: () => void) {
    if (value !== NEW_CAT) {
      onSetCategory(name, value);
      return;
    }
    const created = await createCategory();
    if (!created) {
      resetSelect();
      return;
    }
    onSetCategory(name, created);
    invalidate();
  }

  return (
    <Modal
      title="Edit Catalog"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <input
            type="text"
            className={styles.textInput}
            style={{ flex: 2, minWidth: 0 }}
            placeholder="New item..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addItem();
            }}
          />
          <select
            className={styles.select}
            style={{ flex: 1, minWidth: 0 }}
            value={newCat}
            aria-label="New item category"
            onChange={(e) => {
              if (e.target.value === NEW_CAT) {
                void createCategory().then((created) => {
                  if (created) setNewCat(created);
                });
                return;
              }
              setNewCat(e.target.value);
            }}
          >
            {categoryOrder.map((c) => (
              <option key={c} value={c}>
                {categoryLabels[c] || c}
              </option>
            ))}
            <option value={NEW_CAT}>+ New category…</option>
          </select>
          <button type="button" className={styles.primaryBtn} onClick={() => void addItem()}>
            Add
          </button>
        </>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <button type="button" className={`${styles.smallBtn} ${styles.smallBtnAccent}`} onClick={onManageCategories}>
          ⚙︎ Manage categories
        </button>
      </div>
      {items.map(([name, cat]) => {
        const safety = safetyTags[name] || '';
        const safeActive = safety === 'safe';
        const suspectActive = safety === 'suspect';
        return (
          <div
            key={name}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', borderBottom: '1px solid var(--border)' }}
          >
            <input
              type="text"
              className={styles.textInput}
              style={{ flex: 2, minWidth: 0, fontSize: 13 }}
              defaultValue={capitalize(name)}
              aria-label={`Rename ${name}`}
              onBlur={(e) => {
                void saveRename(name, e.target.value, () => {
                  e.target.value = capitalize(name);
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <select
              className={styles.select}
              style={{ flex: 1, minWidth: 0 }}
              value={cat}
              aria-label={`Category for ${name}`}
              onChange={(e) => {
                const sel = e.target;
                void selectCategory(name, sel.value, () => {
                  sel.value = cat;
                });
              }}
            >
              {!categoryOrder.includes(cat) ? <option value={cat}>{cat}</option> : null}
              {categoryOrder.map((c) => (
                <option key={c} value={c}>
                  {categoryLabels[c] || c}
                </option>
              ))}
              <option value={NEW_CAT}>+ New category…</option>
            </select>
            <button
              type="button"
              title="Mark safe"
              onClick={() => void toggleSafety(name, 'safe')}
              style={{
                background: safeActive ? 'rgba(58,158,140,0.18)' : 'none',
                border: `1px solid ${safeActive ? 'var(--green)' : 'var(--border)'}`,
                borderRadius: 6,
                padding: '3px 7px',
                fontSize: 12,
                color: safeActive ? 'var(--green)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontWeight: safeActive ? 700 : 400,
                minHeight: 40,
                minWidth: 40,
              }}
            >
              &#10003;
            </button>
            <button
              type="button"
              title="Mark suspect"
              onClick={() => void toggleSafety(name, 'suspect')}
              style={{
                background: suspectActive ? 'rgba(212,140,68,0.18)' : 'none',
                border: `1px solid ${suspectActive ? 'var(--orange)' : 'var(--border)'}`,
                borderRadius: 6,
                padding: '3px 7px',
                fontSize: 12,
                color: suspectActive ? 'var(--orange)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontWeight: suspectActive ? 700 : 400,
                minHeight: 40,
                minWidth: 40,
              }}
            >
              &#9888;
            </button>
            <button
              type="button"
              className={styles.deleteBtn}
              style={{ color: 'var(--red)', fontSize: 18 }}
              title="Delete"
              onClick={() => onConfirmDelete(name)}
            >
              &times;
            </button>
          </div>
        );
      })}
    </Modal>
  );
}
