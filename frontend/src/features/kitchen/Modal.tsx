import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './kitchen.module.css';

export interface ModalProps {
  title?: ReactNode;
  onClose: () => void;
  /** 'default' 480px · 'wide' 640px · 'tall' full-height receipt-import style */
  size?: 'default' | 'wide' | 'tall';
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Feature-local modal shell — ports the old fixed overlay + card modals
 * (item-note, catalog editor, receipt import…). Portaled to document.body for
 * the same stacking reasons as ui/Sheet; backdrop click and Escape close it.
 */
export function Modal({ title, onClose, size = 'default', children, footer }: ModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const sizeClass = size === 'wide' ? styles.modalWide : size === 'tall' ? styles.modalTall : '';

  return createPortal(
    <div
      className={styles.overlay}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`${styles.modalBox} ${sizeClass}`} role="dialog" aria-modal="true">
        <div className={styles.modalHead}>
          <div className={styles.modalTitle}>{title}</div>
          <button type="button" className={styles.modalClose} aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className={styles.modalBody}>{children}</div>
        {footer ? <div className={styles.modalFoot}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
