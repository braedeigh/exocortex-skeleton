import styles from './Toast.module.css';

export interface ToastItem {
  id: number;
  message: string;
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
        <div className={styles.toast} key={t.id}>
          <span className={styles.message}>{t.message}</span>
          <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
