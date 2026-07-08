import type { ReactNode } from 'react';
import { IconButton } from './IconButton';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
}

/** Touch-first bottom sheet — full-bleed on mobile, close button 44x44px. */
export function Sheet({ open, title, onClose, children }: SheetProps) {
  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.grabber} aria-hidden="true" />
        {title ? (
          <div className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            <IconButton aria-label="Close" onClick={onClose}>
              &times;
            </IconButton>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
