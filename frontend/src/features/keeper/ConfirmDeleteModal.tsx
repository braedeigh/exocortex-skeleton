import { useEffect } from 'react';
import styles from './ConfirmDeleteModal.module.css';

export interface ConfirmDeleteModalProps {
  open: boolean;
  /** Vault-relative path shown in the card. */
  path: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Delete confirmation — destructive actions confirm first (house rule).
 * Esc or a click outside the card cancels, same as the legacy overlay. */
export function ConfirmDeleteModal({ open, path, onCancel, onConfirm }: ConfirmDeleteModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={styles.card} role="dialog" aria-modal="true" aria-labelledby="keeper-confirm-title">
        <div className={styles.title} id="keeper-confirm-title">
          Delete this file?
        </div>
        <div className={styles.name}>{path}</div>
        <div className={styles.msg}>This removes it from the keeper&apos;s memory. You can undo right after.</div>
        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={styles.deleteBtn} onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
