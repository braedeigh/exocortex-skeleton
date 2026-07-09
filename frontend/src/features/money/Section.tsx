import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './money.module.css';

export interface SectionProps {
  /** Summary line content (title + live totals). */
  summary: ReactNode;
  /** Initial open state — matches the old markup's `open` attribute. */
  defaultOpen?: boolean;
  /** Controlled open state (CSV import forces itself open with a preview). */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Collapsible card section — the `<details class="card-section"><summary>…
 * <div class="card">` pattern every Money area used. Uncontrolled by default
 * (open state lives here, so the 5s poll never snaps it back), controllable
 * for the CSV import flow.
 */
export function Section({ summary, defaultOpen = false, open, onToggle, children }: SectionProps) {
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  const isOpen = open !== undefined ? open : selfOpen;
  const ref = useRef<HTMLDetailsElement>(null);

  // React skips re-applying an unchanged `open` prop, so a user-toggled
  // <details> can drift from a pinned controlled value (e.g. the CSV section
  // held open while a preview is loaded) — resync the DOM after each render.
  useEffect(() => {
    if (ref.current && ref.current.open !== isOpen) ref.current.open = isOpen;
  });

  return (
    <details
      ref={ref}
      className={styles.section}
      open={isOpen}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        if (next === isOpen) return;
        if (onToggle) onToggle(next);
        if (open === undefined) setSelfOpen(next);
      }}
    >
      <summary className={styles.summary}>{summary}</summary>
      <div className={styles.card}>{children}</div>
    </details>
  );
}
