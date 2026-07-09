/**
 * "Past Consumables" — retired items grouped by category, newest-retired
 * first (inventory.js renderPastInventory). Thoughts cell edits the review;
 * "Bring back" un-retires; × is a two-step-confirm delete. Collapsed by
 * default, hidden entirely when there's nothing retired.
 */
import { groupPastByCategory, usedRangeText } from './inventoryHelpers';
import type { ActiveItem } from './types';
import styles from './inventory.module.css';

export interface PastInventorySectionProps {
  items: ActiveItem[];
  open: boolean;
  onEditReview: (name: string) => void;
  onUnretire: (name: string) => void;
  onDelete: (name: string) => void;
}

export function PastInventorySection({
  items,
  open,
  onEditReview,
  onUnretire,
  onDelete,
}: PastInventorySectionProps) {
  if (!items.length) return null;
  const groups = groupPastByCategory(items);

  return (
    <details className={styles.section} open={open} style={{ marginTop: 16 }}>
      <summary className={styles.summary}>
        Past Consumables{items.length ? ` (${items.length})` : ''}
      </summary>
      <div className={styles.sectionBody}>
        {groups.map((g) => (
          <div className={styles.kindGroup} key={g.category}>
            <div className={styles.catHeader}>
              {g.label} <span className={styles.count}>({g.items.length})</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Used</th>
                    <th>Thoughts</th>
                    <th className={styles.thRight}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((item) => {
                    const used = usedRangeText(item);
                    return (
                      <tr key={item.name}>
                        <td>
                          <b>{item.name}</b>
                        </td>
                        <td className={`${styles.tdNowrap} ${styles.tdSmall} ${styles.tdMuted}`}>
                          {used || <span className={styles.emptyDash}>—</span>}
                        </td>
                        <td
                          className={`${styles.tdSmall} ${styles.reviewCell}`}
                          onClick={() => onEditReview(item.name)}
                          title="Click to edit"
                        >
                          {item.review ? (
                            <span className={styles.reviewText} title={item.review}>
                              {item.review}
                            </span>
                          ) : (
                            <span className={styles.noReview}>no thoughts logged</span>
                          )}
                        </td>
                        <td className={styles.tdActions}>
                          <button
                            type="button"
                            className={styles.smallBtnGreen}
                            title="Bring back to active"
                            onClick={() => onUnretire(item.name)}
                          >
                            Bring back
                          </button>
                          <button
                            type="button"
                            className={`${styles.deleteBtn} ${styles.smallBtnGap}`}
                            title="Delete forever"
                            aria-label={`Delete ${item.name} forever`}
                            onClick={() => onDelete(item.name)}
                          >
                            &times;
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
