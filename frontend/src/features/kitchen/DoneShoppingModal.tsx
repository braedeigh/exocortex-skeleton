import { createPortal } from 'react-dom';
import styles from './kitchen.module.css';

export interface DoneShoppingModalProps {
  onScanReceipt: (file: File) => void;
  onFinishWithoutReceipt: () => void;
  onNotYet: () => void;
}

/** Port of #kitchen-done-modal — auto-pops when every item is checked.
 * Scan clears checked items first (the trip is finished), then uploads. */
export function DoneShoppingModal({ onScanReceipt, onFinishWithoutReceipt, onNotYet }: DoneShoppingModalProps) {
  return createPortal(
    <div className={styles.overlay} style={{ zIndex: 200 }} role="presentation">
      <div className={styles.modalBox} style={{ maxWidth: 420, textAlign: 'left' }} role="dialog" aria-modal="true">
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Done shopping? 🛒</div>
        <div className={styles.muted13} style={{ marginBottom: 16 }}>
          Scan your receipt to log the trip (recommended — feeds spend tracking + buy-frequency), or finish without
          one.
        </div>
        <label
          className={styles.fileLabel}
          style={{
            display: 'flex',
            padding: '12px 14px',
            borderRadius: 8,
            background: 'var(--green)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            textAlign: 'center',
            justifyContent: 'center',
            marginBottom: 8,
            minHeight: 48,
          }}
        >
          📷 Scan receipt
          <input
            type="file"
            accept="image/*,.heic,.heif,.pdf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onScanReceipt(f);
              e.target.value = '';
            }}
          />
        </label>
        <button
          type="button"
          onClick={onFinishWithoutReceipt}
          style={{
            display: 'block',
            width: '100%',
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'none',
            color: 'var(--text)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            marginBottom: 8,
            minHeight: 44,
          }}
        >
          Finish without receipt
        </button>
        <button
          type="button"
          onClick={onNotYet}
          style={{
            display: 'block',
            width: '100%',
            padding: 8,
            borderRadius: 8,
            border: 'none',
            background: 'none',
            color: 'var(--text-muted)',
            fontSize: 12,
            cursor: 'pointer',
            minHeight: 44,
          }}
        >
          Not yet — keep this trip open
        </button>
      </div>
    </div>,
    document.body,
  );
}
