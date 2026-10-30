import type { ReactNode } from 'react';
import styles from './PanelFrame.module.css';

/**
 * PanelFrame.tsx — the chrome around one panel: its tabs, and the three things
 * you can do to the panel itself.
 *
 * One header row, ~40px so everything in it is a comfortable target. The panel
 * hands in what fills the left of that row — its tab bar (TabBar.tsx) — and this
 * adds, at the right, a button to split
 * beside, a button to split below, and a close.
 *
 * That's the entire vocabulary of the workspace: whatever you can arrange, you
 * arrange with those three. The one panel the Observatory fills the window from
 * also gets a fourth, the switch for that.
 *
 * Every panel can be closed while more than one is open — the primary too,
 * which hands the address bar to a neighbour first (layoutTree.closePanel).
 * The last panel standing has no close button: absent rather than disabled,
 * because a disabled button invites you to wonder what you did wrong.
 *
 * Touches: PanelTree.tsx (renders these), TabBar.tsx (what goes in the header).
 */
export function PanelFrame({
  onSplitRight,
  onSplitDown,
  onClose,
  headerLeft,
  fullScreen,
  children,
}: {
  onSplitRight: () => void;
  onSplitDown: () => void;
  /** Omitted when this panel can't close — it's the last one. */
  onClose?: () => void;
  headerLeft?: ReactNode;
  /** On the panel the Observatory fills the window from: the on/off switch for
   * that (layoutTree.fullScreenPlan). Absent on every other panel. */
  fullScreen?: { on: boolean; onToggle: () => void };
  children: ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <header className={styles.head}>
        {headerLeft}
        <div className={styles.actions}>
          {fullScreen ? (
            <button
              type="button"
              className={styles.action}
              onClick={fullScreen.onToggle}
              aria-pressed={fullScreen.on}
              title={fullScreen.on ? 'Show your other panels beside this' : 'Fill the window with this page'}
              aria-label={fullScreen.on ? 'Show your other panels beside this' : 'Fill the window with this page'}
            >
              {fullScreen.on ? <ShrinkIcon /> : <FillIcon />}
            </button>
          ) : null}
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

function FillIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShrinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
