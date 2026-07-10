/**
 * Card.tsx — collapsible <details> card, the dashboard map-section feel.
 * Open/closed persists per cardId in localStorage under the legacy
 * 'rsrch-open-cards' key (cardState.ts).
 */

import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { readCardOpen, writeCardOpen } from './cardState';
import styles from './ResearchPage.module.css';

export interface CardProps {
  cardId: string;
  defaultOpen: boolean;
  title: ReactNode;
  count?: ReactNode;
  /** buttons on the summary line (they stopPropagation themselves) */
  extras?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Card({ cardId, defaultOpen, title, count, extras, className, children }: CardProps) {
  // Toggled-this-visit wins; otherwise localStorage; otherwise the default.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? readCardOpen(cardId, defaultOpen);

  function onToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    const next = e.currentTarget.open;
    if (next === open) return;
    setOverride(next);
    writeCardOpen(cardId, next);
  }

  return (
    <details className={`${styles.card} ${className ?? ''}`} open={open} onToggle={onToggle} data-card={cardId}>
      <summary className={styles.cardSummary}>
        <span className={styles.arrow}>&#9654;</span>
        <span className={styles.summaryTitle}>
          {title}
          {count !== undefined ? <span className={styles.cardCount}>{count}</span> : null}
        </span>
        {extras}
      </summary>
      {children}
    </details>
  );
}

/** Stop a summary-line button from toggling the <details>. */
export function summaryAction(fn: () => void) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
}
