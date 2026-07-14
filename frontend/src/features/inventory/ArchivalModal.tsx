/**
 * Add/edit modal for the archivals catalog (archivals.js openArchivalModal).
 * New items take photos in the same multipart POST; existing items manage
 * photos live — add uploads immediately, × deletes, ★ promotes to main — and
 * each photo edit refetches so the strip repaints (the old
 * _archReloadAndReopen). Delete goes through the shared two-step confirm.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ARCH_SECONDHAND,
  capitalize,
  formatArchDate,
  knownArchCategories,
  materialsText,
} from './archivalHelpers';
import { Modal } from './Modal';
import type { ArchivalFieldsPayload } from './api';
import type { ArchivalItem } from './types';
import modalStyles from './Modal.module.css';
import styles from './inventory.module.css';

interface ArchFormState {
  name: string;
  category: string;
  subcategory: string;
  origin: string;
  materials: string;
  description: string;
  secondhand: string;
  gifted: boolean;
  private: boolean;
}

/** Starter values for a new item — the bought-from-buy-list flow prefills
 * the purchase record (date, cost, source, research notes) through this. */
export interface ArchivalPrefill {
  name?: string;
  category?: string;
  origin?: string;
  description?: string;
  secondhand?: string;
}

function formFromItem(item: ArchivalItem | null, prefill?: ArchivalPrefill): ArchFormState {
  return {
    name: item?.name || prefill?.name || '',
    category: item?.category || prefill?.category || '',
    subcategory: item?.subcategory || '',
    origin: item?.origin || prefill?.origin || '',
    materials: item ? materialsText(item) : '',
    description: item?.description || prefill?.description || '',
    secondhand: item?.secondhand || prefill?.secondhand || 'unknown',
    gifted: item?.gifted === 'yes',
    private: item?.private === 'yes',
  };
}

function payloadFromForm(form: ArchFormState): ArchivalFieldsPayload {
  return {
    name: form.name.trim(),
    category: form.category.trim().toLowerCase(),
    subcategory: form.subcategory.trim().toLowerCase(),
    origin: form.origin.trim(),
    materials: form.materials.trim(),
    description: form.description.trim(),
    secondhand: form.secondhand,
    gifted: form.gifted ? 'yes' : 'no',
    private: form.private ? 'yes' : 'no',
  };
}

export interface ArchivalModalProps {
  /** null = add a new thing. Kept live from the polled list so photo edits repaint. */
  item: ArchivalItem | null;
  /** New-item starter values (bought-from-buy-list flow). Ignored when editing. */
  prefill?: ArchivalPrefill;
  allItems: ArchivalItem[];
  onClose: () => void;
  onError: (message: string) => void;
  onSaveAdd: (fields: ArchivalFieldsPayload, photos: File[]) => Promise<void>;
  onSaveUpdate: (id: string, fields: ArchivalFieldsPayload) => Promise<void>;
  /** Two-step confirm then remove — runs in the page's shared confirm dialog. */
  onDelete: (id: string, name: string) => void;
  onAddPhotos: (itemId: string, photos: File[]) => Promise<void>;
  onRemovePhoto: (itemId: string, photoId: string) => Promise<void>;
  onSetMainPhoto: (itemId: string, photoId: string) => Promise<void>;
}

export function ArchivalModal({
  item,
  prefill,
  allItems,
  onClose,
  onError,
  onSaveAdd,
  onSaveUpdate,
  onDelete,
  onAddPhotos,
  onRemovePhoto,
  onSetMainPhoto,
}: ArchivalModalProps) {
  const isNew = !item;
  const [form, setForm] = useState<ArchFormState>(() => formFromItem(item, prefill));
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) setTimeout(() => nameRef.current?.focus(), 50);
  }, [isNew]);

  const patch = (p: Partial<ArchFormState>) => setForm((f) => ({ ...f, ...p }));

  async function save() {
    const payload = payloadFromForm(form);
    if (!payload.name) {
      onError('Name is required');
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const files = fileRef.current?.files ? [...fileRef.current.files] : [];
        await onSaveAdd(payload, files);
      } else {
        await onSaveUpdate(item.id, payload);
      }
      onClose();
    } catch (e) {
      onError(e instanceof Error && e.message ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function uploadPhotos() {
    if (!item || !fileRef.current?.files?.length) return;
    const files = [...fileRef.current.files];
    try {
      await onAddPhotos(item.id, files);
    } catch (e) {
      onError(e instanceof Error && e.message ? e.message : 'Photo upload failed');
    } finally {
      // Reset even on failure — a same-file re-pick wouldn't fire onChange.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const photos = item?.photos || [];

  return (
    <Modal open onClose={onClose} editor aria-label={isNew ? 'Add a thing' : 'Edit thing'}>
      <div className={modalStyles.modalHead}>
        <div className={modalStyles.modalTitle}>{isNew ? 'Add a thing' : 'Edit thing'}</div>
        <button type="button" className={modalStyles.closeBtn} aria-label="Close" onClick={onClose}>
          &times;
        </button>
      </div>

      {isNew && prefill ? (
        <div className={styles.prefillHint}>
          📷 Attach your order screenshot below — and add a real photo when it arrives.
        </div>
      ) : null}
      <label className={styles.fieldLabel} style={{ display: 'block', marginBottom: 6 }}>
        {isNew ? 'Photos (up to 5)' : 'Photos'}
      </label>
      {!isNew ? (
        <div className={styles.photoStrip}>
          {photos.length ? (
            photos.map((p, idx) => (
              <div className={styles.photoWrap} key={p.id}>
                <img
                  className={`${styles.photoThumb} ${idx === 0 ? styles.photoThumbMain : ''}`}
                  src={`/archivals/photo/${encodeURIComponent(p.filename)}`}
                  loading="lazy"
                  alt=""
                />
                <button
                  type="button"
                  className={styles.photoDelete}
                  title="Delete photo"
                  aria-label="Delete photo"
                  onClick={() =>
                    void onRemovePhoto(item.id, p.id).catch(() => onError("Couldn't delete the photo"))
                  }
                >
                  &times;
                </button>
                {idx !== 0 ? (
                  <button
                    type="button"
                    className={styles.photoMain}
                    title="Make main photo"
                    aria-label="Make main photo"
                    onClick={() =>
                      void onSetMainPhoto(item.id, p.id).catch(() => onError("Couldn't set the main photo"))
                    }
                  >
                    ★
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <span className={styles.noneYet}>No photos yet</span>
          )}
        </div>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className={styles.photoInput}
        onChange={isNew ? undefined : () => void uploadPhotos()}
      />

      <div className={styles.archFormGrid}>
        <input
          ref={nameRef}
          type="text"
          className={styles.input}
          style={{ fontSize: 15, fontWeight: 600 }}
          placeholder="Name *"
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <div className={styles.formRow} style={{ marginBottom: 0 }}>
          <input
            type="text"
            className={`${styles.input} ${styles.grow}`}
            list="inv-arch-categories"
            placeholder="Category"
            value={form.category}
            onChange={(e) => patch({ category: e.target.value })}
          />
          <datalist id="inv-arch-categories">
            {knownArchCategories(allItems).map((c) => (
              <option value={c} key={c} />
            ))}
          </datalist>
          <input
            type="text"
            className={`${styles.input} ${styles.grow}`}
            placeholder="Subcategory"
            value={form.subcategory}
            onChange={(e) => patch({ subcategory: e.target.value })}
          />
        </div>
        <input
          type="text"
          className={styles.input}
          placeholder="Origin — where it came from (store, gift from mom...)"
          value={form.origin}
          onChange={(e) => patch({ origin: e.target.value })}
        />
        <input
          type="text"
          className={styles.input}
          placeholder="Materials — e.g. Cotton 80, Polyester 20"
          value={form.materials}
          onChange={(e) => patch({ materials: e.target.value })}
        />
        <textarea
          className={styles.textarea}
          rows={5}
          placeholder="The story — keep it in your own words"
          value={form.description}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <div className={styles.formRow} style={{ marginBottom: 0, alignItems: 'center' }}>
          <select
            className={styles.select}
            value={form.secondhand}
            aria-label="Source"
            onChange={(e) => patch({ secondhand: e.target.value })}
          >
            {ARCH_SECONDHAND.map((s) => (
              <option value={s} key={s}>
                {capitalize(s)}
              </option>
            ))}
          </select>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={form.gifted}
              onChange={(e) => patch({ gifted: e.target.checked })}
            />{' '}
            Gifted
          </label>
          <label className={styles.checkLabel} title="Hidden from the public site entirely">
            <input
              type="checkbox"
              checked={form.private}
              onChange={(e) => patch({ private: e.target.checked })}
            />{' '}
            🔒 Private
          </label>
        </div>
      </div>

      {!isNew && (item.created_at || item.last_edited) ? (
        <div className={styles.archMeta}>
          {item.created_at ? `Added ${formatArchDate(item.created_at, true)}` : ''}
          {item.created_at && item.last_edited ? ' · ' : ''}
          {item.last_edited ? `Edited ${formatArchDate(item.last_edited, true)}` : ''}
        </div>
      ) : null}

      <div className={styles.footerRow} style={{ marginTop: 18 }}>
        {isNew ? (
          <span />
        ) : (
          <button
            type="button"
            className={styles.dangerOutlineBtn}
            onClick={() => onDelete(item.id, item.name || 'this thing')}
          >
            Delete
          </button>
        )}
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
