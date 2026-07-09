import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './ConfirmModal.module.css';

export interface ConfirmModalProps {
  open: boolean;
  /** e.g. <>Remove the <b>Sitting</b> cell?</> */
  text: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Two-step delete confirmation — port of the legacy #modal overlay
 * (templates/index.html + core.js confirmDelete/executeDelete), which the
 * old Meditation tab used for cell removal; the deity delete's native
 * confirm() goes through this same modal now. Portaled to document.body for
 * the same stacking-context reason as ui/Sheet.
 */
export function ConfirmModal({ open, text, confirmLabel = 'Yes, remove', onConfirm, onCancel }: ConfirmModalProps) {
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
      <div className={styles.modal} role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className={styles.text}>{text}</p>
        <div className={styles.buttons}>
          <button type="button" className={`${styles.btn} ${styles.confirm}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" className={`${styles.btn} ${styles.cancel}`} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
