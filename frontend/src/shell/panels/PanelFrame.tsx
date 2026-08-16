import type { ReactNode } from 'react';
import styles from './PanelFrame.module.css';

/**
 * PanelFrame.tsx — the chrome around one panel: its tabs, and the three things
 * you can do to the panel itself.
 *
 * One header row, ~40px so everything in it is a comfortable target. The panel
 * hands in what fills the left of that row — its tab bar (TabBar.tsx), or the
 * reading room's own switcher — and this adds, at the right, a button to split
 * beside, a button to split below, and a close.
 *
 * That's the entire vocabulary of the workspace: whatever you can arrange, you
 * arrange with those three.
 *
 * The primary panel can't be closed — it's the one holding the browser's
 * address and the back button, so closing it would leave the window with no way
 * to navigate. Its close button is absent rather than disabled, because a
 * disabled button invites you to wonder what you did wrong.
 *
 * Touches: PanelTree.tsx (renders these), TabBar.tsx and PaneStack.tsx (what
 * goes in the header).
 */
export function PanelFrame({
  onSplitRight,
  onSplitDown,
  onClose,
  headerLeft,
  children,
}: {
  onSplitRight: () => void;
  onSplitDown: () => void;
  /** Omitted for the primary panel, which must always exist. */
  onClose?: () => void;
  headerLeft?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <header className={styles.head}>
        {headerLeft}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={onSplitRight}
            title="Split beside this"
            aria-label="Split beside this"
          >
            <SplitRightIcon />
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={onSplitDown}
            title="Split below this"
            aria-label="Split below this"
          >
            <SplitDownIcon />
          </button>
          {onClose ? (
            <button
              type="button"
              className={styles.action}
              onClick={onClose}
              title="Close this panel"
              aria-label="Close this panel"
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

/* Drawn rather than typed: the box-drawing characters that mean "split" don't
   render in every font, and a control that sometimes shows a tofu box is not a
   control. These are 16px, inherit the button's colour, and stay crisp. */

function SplitRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SplitDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
