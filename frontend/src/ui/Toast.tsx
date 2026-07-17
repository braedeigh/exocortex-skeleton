import styles from './Toast.module.css';

export interface ToastItem {
  id: number;
  message: string;
  /** 'error' (default, red) for failures; 'info' (neutral) for confirmations
   * like "Entry removed" that pair with an undo action. */
  tone?: 'error' | 'info';
  /** Paired action button (e.g. "Undo") — fires and dismisses the toast. */
  actionLabel?: string;
  onAction?: () => void;
  /** When present, the message text itself becomes a tappable region (e.g.
   * "jump to where this landed") — separate from the Undo action button. */
  onMessageTap?: () => void;
}

export interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (!toasts.length) return null;

  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className={`${styles.toast} ${t.tone === 'info' ? styles.info : ''}`} key={t.id}>
          {t.onMessageTap ? (
            <button type="button" className={styles.messageBtn} onClick={() => t.onMessageTap?.()}>
              {t.message}
            </button>
          ) : (
            <span className={styles.message}>{t.message}</span>
          )}
          {t.actionLabel && t.onAction ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                t.onAction?.();
                onDismiss(t.id);
              }}
            >
              {t.actionLabel}
            </button>
          ) : null}
          <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
