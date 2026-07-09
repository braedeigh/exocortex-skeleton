import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Modals.module.css';

export interface EditorModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Generic editor modal — port of index.html's #panel-modal + core.js
 * showEditorModal/hideEditorModal. One at a time: habit edit, habit config,
 * manage reminders, manage contacts all render into this shell.
 * Portaled to <body> for the same stacking-context reason as ui/Sheet.
 */
export function EditorModal({ title, onClose, children }: EditorModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className={styles.overlay} role="presentation">
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>{title}</h3>
          <button type="button" className={styles.panelX} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className={styles.panelBody}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmModalProps {
  /** null = closed. */
  text: ReactNode | null;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Delete confirmation modal — port of index.html's #modal (two-step deletes). */
export function ConfirmModal({ text, confirmLabel = 'Yes, remove', onConfirm, onCancel }: ConfirmModalProps) {
  if (text === null) return null;
  return createPortal(
    <div className={styles.overlay} role="presentation" onClick={onCancel}>
      <div className={styles.modal} role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className={styles.modalText}>{text}</p>
        <div className={styles.buttons}>
          <button type="button" className={styles.confirm} onClick={onConfirm}>
            {confirmLabel}
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

export interface CompanionModalProps {
  /** null = closed. */
  text: ReactNode | null;
  onYes: () => void;
  onNo: () => void;
}

/** Companion reminder prompt — port of #companion-modal ("logged sheets —
 * did you also do eye masks?"). */
export function CompanionModal({ text, onYes, onNo }: CompanionModalProps) {
  if (text === null) return null;
  return createPortal(
    <div className={styles.overlay} role="presentation">
      <div className={styles.modal} role="alertdialog" aria-modal="true" style={{ maxWidth: 420 }}>
        <p className={styles.modalText}>{text}</p>
        <div className={styles.buttons}>
          <button type="button" className={styles.confirmOngoing} onClick={onYes}>
            Yes, did it
          </button>
          <button type="button" className={styles.cancel} onClick={onNo}>
            Not this time
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
