import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './ConfirmModal.module.css';

export interface ConfirmRequest {
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
}

/** Two-step delete confirm — React port of the old #modal / confirmDelete flow. */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const confirm = useCallback((req: ConfirmRequest) => setRequest(req), []);
  const close = useCallback(() => setRequest(null), []);
  return { request, confirm, close };
}

export function ConfirmModal({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  if (!request) return null;
  return createPortal(
    <div
      className={styles.overlay}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal} role="alertdialog" aria-modal="true">
        <p className={styles.text}>{request.message}</p>
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.confirm}
            onClick={() => {
              request.onConfirm();
              onClose();
            }}
          >
            {request.confirmLabel || 'Yes, remove'}
          </button>
          <button type="button" className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
