/**
 * "Consumables" — the active inventory tables, grouped by category with
 * running-low rows first (inventory.js renderActiveInventory). Restock flips
 * status + auto-adds to the buy list; Retire prompts for a review; × is a
 * two-step-confirm delete. Hidden entirely when there's nothing active.
 */
import { notesOneLine, groupActiveByCategory, orderHistoryText, statusMeta } from './inventoryHelpers';
import type { ActiveItem } from './types';
import styles from './inventory.module.css';

export interface ActiveInventorySectionProps {
  items: ActiveItem[];
  open: boolean;
  onRestock: (name: string) => void;
  onRetire: (name: string) => void;
  onDelete: (name: string) => void;
}

export function ActiveInventorySection({
  items,
  open,
  onRestock,
  onRetire,
  onDelete,
}: ActiveInventorySectionProps) {
  if (!items.length) return null;
  const groups = groupActiveByCategory(items);

  return (
    <details className={styles.section} open={open}>
      <summary className={styles.summary}>
        Consumables{items.length ? ` (${items.length})` : ''}
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
                    <th>Last cost</th>
                    <th>Status</th>
                    <th>Notes</th>
                    <th className={styles.thRight}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((item) => {
                    const status = item.status || 'in_use';
                    const meta = statusMeta(status);
                    const oneLine = notesOneLine(item.notes);
                    const history = orderHistoryText(item);
                    return (
                      <tr key={item.name}>
                        <td>
                          <b>{item.name}</b>
                          {item.order_url ? (
                            <a
                              className={styles.orderLink}
                              href={item.order_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Order page"
                            >
                              ↗
                            </a>
                          ) : null}
                          {history ? <div className={styles.historyText}>{history}</div> : null}
                        </td>
                        <td className={`${styles.tdNowrap} ${styles.tdSmall}`}>
                          {item.last_cost || <span className={styles.emptyDash}>—</span>}
                        </td>
                        <td className={styles.tdNowrap}>
                          <span className={styles.statusBadge} style={{ background: meta.color }}>
                            {meta.label}
                          </span>
                        </td>
                        <td className={styles.tdSmall}>
                          {oneLine ? (
                            <span className={styles.notesCell} title={item.notes}>
                              {oneLine}
                            </span>
                          ) : (
                            <span className={styles.emptyDash}>—</span>
                          )}
                        </td>
                        <td className={styles.tdActions}>
                          {status !== 'running_low' ? (
                            <button
                              type="button"
                              className={styles.smallBtnRed}
                              title="Mark running low — auto-adds to buy list"
                              onClick={() => onRestock(item.name)}
                            >
                              Restock
                            </button>
                          ) : (
                            <span className={styles.onBuyList}>on buy list</span>
                          )}
                          <button
                            type="button"
                            className={`${styles.smallBtn} ${styles.smallBtnGap}`}
                            title="Move to Past — log when you stopped + your thoughts"
                            onClick={() => onRetire(item.name)}
                          >
                            Retire
                          </button>
                          <button
                            type="button"
                            className={`${styles.deleteBtn} ${styles.smallBtnGap}`}
                            title="Remove"
                            aria-label={`Remove ${item.name}`}
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
