import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Touch-first bottom sheet — full-bleed on mobile, close button 44x44px.
 *
 * Rendered via a portal straight onto `document.body` rather than in place.
 * Reason: the desktop terminal pane (SplitLayout's `.left`) sets
 * `isolation: isolate` to contain its own floating widgets, but that also
 * traps any `position: fixed` descendant's stacking — including this sheet
 * — inside that local stacking context. Anything outside `.left` with an
 * explicit positive z-index (e.g. the to-do page's NotesPill, z-index 45)
 * then paints *over* the whole isolated pane regardless of this sheet's own
 * z-index (100), because the pane itself only ever participates at the
 * default "z-index: auto" level from the page's perspective. Portaling
 * escapes that ancestor entirely, so the sheet always stacks by its own
 * z-index at the document root — this fixed "new session modal renders
 * behind the habits/to-do lists" (NewSessionDialog, which uses this Sheet).
 */
export function Sheet({ open, title, onClose, children }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
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
    </div>,
    document.body,
  );
}
