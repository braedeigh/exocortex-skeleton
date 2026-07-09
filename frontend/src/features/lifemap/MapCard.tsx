import { useState, type ReactNode } from 'react';
import styles from './MapCard.module.css';

const STORAGE_PREFIX = 'mapCardOpen:'; // same key the old core.js used

function readOpen(cardKey: string, defaultOpen: boolean): boolean {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + cardKey);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // localStorage unavailable — fall through to the default
  }
  return defaultOpen;
}

export interface MapCardProps {
  /** data-card key ('habit' | 'activity' | 'contacts') — drives the
   * localStorage open/closed memory. */
  cardKey: string;
  title: string;
  /** Old data-default-open attribute. */
  defaultOpen?: boolean;
  /** Title-line button label ("Edit" / "Manage reminders" / "Manage"). */
  editLabel?: string;
  onEdit?: () => void;
  children: ReactNode;
}

/**
 * Collapsible Life Map card — port of the `<details class="map-section
 * kitchen-section">` blocks in index.html #tab-map + core.js
 * mapCardToggled/restoreMapCards (open state remembered per card).
 */
export function MapCard({ cardKey, title, defaultOpen = false, editLabel, onEdit, children }: MapCardProps) {
  const [open, setOpen] = useState(() => readOpen(cardKey, defaultOpen));

  function onToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    const next = e.currentTarget.open;
    if (next === open) return;
    setOpen(next);
    try {
      localStorage.setItem(STORAGE_PREFIX + cardKey, next ? '1' : '0');
    } catch {
      // localStorage unavailable — state just won't persist
    }
  }

  return (
    <details
      className={`${styles.card} ${cardKey === 'habit' ? styles.cardHabit : ''}`}
      open={open}
      onToggle={onToggle}
    >
      <summary className={styles.summary}>
        <span className={styles.arrow} aria-hidden="true">
          &#9654;
        </span>
        {title}
        {editLabel && onEdit ? (
          <button
            type="button"
            className={styles.editBtn}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onEdit();
            }}
          >
            {editLabel}
          </button>
        ) : null}
      </summary>
      {children}
    </details>
  );
}
