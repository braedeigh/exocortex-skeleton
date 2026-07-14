import { useState } from 'react';
import { frontLabel } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import type { TodoItem } from './types';
import styles from './NotNowCard.module.css';

export interface NotNowEntry {
  item: TodoItem;
  section: string;
}

export interface NotNowCardProps {
  entries: NotNowEntry[];
  fronts: Front[];
  onOpenDetail: (item: TodoItem) => void;
}

/**
 * The context-gated overflow: items whose front is outside its visibility
 * window right now (gateHides). Collapsed count by default — visible and
 * countable so the list stays trustworthy, never hidden-hidden. Rows open
 * the detail sheet; the header "Show all" toggle reveals them in their real
 * sections instead.
 */
export function NotNowCard({ entries, fronts, onOpenDetail }: NotNowCardProps) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;

  return (
    <div className={styles.card}>
      <button type="button" className={styles.summary} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.arrow} ${open ? styles.open : ''}`} aria-hidden="true">
          &#9654;
        </span>
        <span className={styles.title}>Not now</span>
        <span className={styles.count}>{entries.length}</span>
      </button>
      {open
        ? entries.map(({ item, section }) => (
            <div className={styles.row} key={item.id}>
              <button type="button" className={styles.text} onClick={() => onOpenDetail(item)}>
                {item.text}
              </button>
              <span className={styles.meta}>
                {frontLabel(fronts, item.theme)} &middot; {section}
              </span>
            </div>
          ))
        : null}
    </div>
  );
}
