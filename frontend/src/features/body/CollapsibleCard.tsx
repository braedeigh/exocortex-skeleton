import { useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import styles from './CollapsibleCard.module.css';

const STORAGE_PREFIX = 'mapCardOpen:';

function readStoredOpen(cardKey: string, defaultOpen: boolean): boolean {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + cardKey);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // localStorage unavailable — fall through to the default
  }
  return defaultOpen;
}

export interface CollapsibleCardProps {
  /** localStorage key suffix — same `data-card` names as the old page
   * (symptoms/foodlog/triage/foodsafety/foodexp) so saved collapse states
   * carry over from the legacy tab. */
  cardKey: string;
  title: string;
  defaultOpen?: boolean;
  /** Extra control on the title line (e.g. the Edit button) — hidden while
   * the card is closed, like the legacy .card-edit-btn. */
  titleExtra?: ReactNode;
  /** A short line on the title row that stays visible while the card is
   * closed (e.g. "7 nutrients") — says what's inside without opening it. */
  note?: ReactNode;
  /** Another page's look for the same card: each class given replaces this
   * file's own (the Nutrients pages pass theirs). */
  classes?: { card?: string; summary?: string; arrow?: string; title?: string; note?: string };
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Port of the `<details class="map-section kitchen-section" data-card=…>`
 * card idiom: chevron summary, soft pill styling, open/closed remembered per
 * card in localStorage (core.js mapCardToggled/restoreMapCards).
 */
export function CollapsibleCard({
  cardKey,
  title,
  defaultOpen = false,
  titleExtra,
  note,
  classes = {},
  onToggle,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(() => readStoredOpen(cardKey, defaultOpen));

  function handleToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    const next = e.currentTarget.open;
    if (next === open) return;
    setOpen(next);
    try {
      localStorage.setItem(STORAGE_PREFIX + cardKey, next ? '1' : '0');
    } catch {
      // state just won't persist
    }
    onToggle?.(next);
  }

  return (
    <details className={classes.card ?? styles.card} data-card={cardKey} open={open} onToggle={handleToggle}>
      <summary className={classes.summary ?? styles.summary}>
        <span className={classes.arrow ?? styles.arrow} aria-hidden="true">
          &#9654;
        </span>
        <span className={classes.title ?? styles.title}>{title}</span>
        {note != null ? <span className={classes.note}>{note}</span> : null}
        {open ? titleExtra : null}
      </summary>
      {children}
    </details>
  );
}
