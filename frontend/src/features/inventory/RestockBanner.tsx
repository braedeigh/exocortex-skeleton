/** "Needs Restock (N)" banner — chips for every running_low item, each with
 * an optional ↗ order-page link (inventory.js renderRestockBanner). */
import type { ActiveItem } from './types';
import styles from './inventory.module.css';

export function RestockBanner({ lows }: { lows: ActiveItem[] }) {
  if (!lows.length) return null;
  return (
    <div className={styles.restockBanner}>
      <div className={styles.restockTitle}>Needs Restock ({lows.length})</div>
      <div className={styles.restockChips}>
        {lows.map((item) => (
          <span className={styles.restockChip} key={item.name}>
            {item.name}
            {item.order_url ? (
              <a href={item.order_url} target="_blank" rel="noopener noreferrer" title="Order page">
                ↗
              </a>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}
