import { useState } from 'react';
import { CATEGORY_LABELS } from './catalogHelpers';
import { Modal } from './Modal';
import styles from './kitchen.module.css';

export interface CategoryOrderModalProps {
  order: string[];
  onSave: (order: string[]) => Promise<unknown>;
  onClose: () => void;
}

/** Port of the "Edit order" overlay — up/down arrows over the walking route,
 * with the '@aisles' sentinel called out. */
export function CategoryOrderModal({ order, onSave, onClose }: CategoryOrderModalProps) {
  const [cats, setCats] = useState<string[]>(() =>
    order.length ? order.slice() : Object.keys(CATEGORY_LABELS),
  );

  function move(index: number, dir: -1 | 1) {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= cats.length) return;
    const next = cats.slice();
    [next[index], next[newIndex]] = [next[newIndex], next[index]];
    setCats(next);
  }

  return (
    <Modal
      title="Category Order"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className={styles.primaryBtn}
            style={{ flex: 1 }}
            onClick={() => {
              void onSave(cats).then(onClose);
            }}
          >
            Save
          </button>
          <button type="button" className={styles.mutedBtn} style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className={styles.muted12} style={{ marginBottom: 12 }}>
        Matches your store walking route
      </div>
      {cats.map((cat, i) => {
        const isAisles = cat === '@aisles';
        return (
          <div
            key={cat}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 6px',
              borderBottom: '1px solid var(--border)',
              background: isAisles ? 'rgba(124,92,191,0.10)' : undefined,
            }}
          >
            <span style={{ flex: 1, fontSize: 14 }}>
              {isAisles ? (
                <>
                  Aisles (1, 2, 3…) <span className={styles.muted12}>numbered aisles cluster here</span>
                </>
              ) : (
                CATEGORY_LABELS[cat] || cat
              )}
            </span>
            <button
              type="button"
              className={styles.smallBtn}
              disabled={i === 0}
              style={{ opacity: i === 0 ? 0.2 : 1, fontSize: 14 }}
              onClick={() => move(i, -1)}
              aria-label={`Move ${cat} up`}
            >
              &#9650;
            </button>
            <button
              type="button"
              className={styles.smallBtn}
              disabled={i === cats.length - 1}
              style={{ opacity: i === cats.length - 1 ? 0.2 : 1, fontSize: 14 }}
              onClick={() => move(i, 1)}
              aria-label={`Move ${cat} down`}
            >
              &#9660;
            </button>
          </div>
        );
      })}
    </Modal>
  );
}
