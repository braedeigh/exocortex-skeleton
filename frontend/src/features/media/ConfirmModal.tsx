import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './ConfirmModal.module.css';

export interface ConfirmModalProps {
  open: boolean;
  children: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Centered delete-confirm dialog — port of the old #modal overlay
 * ("Remove <b>title</b>?" with Yes, remove / Cancel). Portaled to body for
 * the same stacking reason as ui/Sheet.
 */
export function ConfirmModal({ open, children, onConfirm, onCancel }: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className={styles.overlay} onClick={onCancel} role="presentation">
      <div
        className={styles.modal}
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <p className={styles.text}>{children}</p>
        <div className={styles.buttons}>
          <button type="button" className={styles.confirm} onClick={onConfirm}>
            Yes, remove
          </button>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
