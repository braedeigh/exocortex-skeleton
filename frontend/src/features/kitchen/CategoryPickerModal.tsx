import { kitchenCats } from './catalogHelpers';
import { Modal } from './Modal';
import styles from './kitchen.module.css';

export interface CategoryPickerModalProps {
  /** the new item's name (shown in the prompt) */
  name: string;
  categoryOrder?: string[];
  onPick: (category: string) => void;
  /** "+ New category…" — parent prompts for a name, persists it, then picks it */
  onNewCategory: () => void;
  onCancel: () => void;
}

/** Port of #kitchen-cat-modal — category chips for a brand-new item. */
export function CategoryPickerModal({ name, categoryOrder, onPick, onNewCategory, onCancel }: CategoryPickerModalProps) {
  const { categoryOrder: order, categoryLabels } = kitchenCats(categoryOrder);
  return (
    <Modal
      title={
        <span>
          New item: <b>{name}</b>
          <br />
          <span className={styles.muted12} style={{ fontWeight: 400 }}>Pick a category</span>
        </span>
      }
      onClose={onCancel}
      footer={
        <button type="button" className={styles.mutedBtn} style={{ marginLeft: 'auto' }} onClick={onCancel}>
          Cancel
        </button>
      }
    >
      <div className={styles.chipWrap}>
        {order.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => onPick(cat)}
            style={{
              minHeight: 44,
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--card-bg)',
              color: 'var(--text)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {categoryLabels[cat] || cat}
          </button>
        ))}
        <button
          type="button"
          onClick={onNewCategory}
          style={{
            minHeight: 44,
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px dashed var(--accent)',
            background: 'none',
            color: 'var(--accent)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + New category…
        </button>
      </div>
    </Modal>
  );
}
