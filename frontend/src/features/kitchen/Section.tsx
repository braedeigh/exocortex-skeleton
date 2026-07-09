import { useState, type ReactNode } from 'react';
import styles from './kitchen.module.css';

export interface SectionProps {
  title: ReactNode;
  /** count pill next to the title (soft accent pill like the old badges) */
  badge?: ReactNode;
  /** right-aligned controls inside the summary row (don't toggle the section) */
  controls?: ReactNode;
  defaultOpen?: boolean;
  /** controlled open state (used by Add to List, whose open state survives re-renders) */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Collapsible card — React port of the old `<details class="kitchen-section">`
 * pill with its rotating chevron. Uses a button summary (not <details>) so the
 * open state survives the 5s poll re-renders.
 */
export function Section({ title, badge, controls, defaultOpen = false, open, onToggle, children }: SectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = open !== undefined ? open : internalOpen;

  function toggle() {
    const next = !isOpen;
    if (open === undefined) setInternalOpen(next);
    onToggle?.(next);
  }

  return (
    <div className={`${styles.section} ${isOpen ? styles.sectionOpen : ''}`}>
      <button type="button" className={styles.summary} onClick={toggle} aria-expanded={isOpen}>
        <span className={`${styles.arrow} ${isOpen ? styles.arrowOpen : ''}`} aria-hidden="true">
          &#9654;
        </span>
        <span>{title}</span>
        {badge}
        {controls ? (
          <span
            className={styles.summaryControls}
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            {controls}
          </span>
        ) : null}
      </button>
      {isOpen ? children : null}
    </div>
  );
}
