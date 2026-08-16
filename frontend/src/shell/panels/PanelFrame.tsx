import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DESTINATIONS, destinationLabel } from './panelDestinations';
import styles from './PanelFrame.module.css';

/**
 * PanelFrame.tsx — the chrome around one tile: what it's showing, and the
 * three things you can do to it.
 *
 * Every tile gets the same header row, ~40px tall so it's a comfortable
 * target: a name on the left, and on the right a button to split it beside
 * itself, a button to split it below itself, and a close. That's the whole
 * vocabulary of the workspace — anything you can arrange, you arrange with
 * those three.
 *
 * The name is a MENU for tiles that show a page (pick a different page), and
 * plain text for the two fixed tiles — the reading room and the primary tile,
 * which are what they are. The primary tile also can't be closed: it's the one
 * holding the browser's address and the tab strip, so closing it would leave
 * the window with no way to navigate. Its close button is absent rather than
 * disabled, because a disabled button invites you to wonder what you did wrong.
 *
 * A tile can pass its own controls into the header via `headerLeft` — the
 * reading room does, so its Observatory / Session / Terminal switcher sits in
 * this row instead of adding a second strip of chrome underneath it.
 *
 * Touches: PanelTree.tsx (renders these), panelDestinations.ts (the menu).
 */

export function PanelFrame({
  title,
  url,
  onPick,
  onSplitRight,
  onSplitDown,
  onClose,
  headerLeft,
  overlayActions,
  children,
}: {
  /** Shown when the tile isn't page-backed (the reading room, the primary). */
  title?: string;
  /** Set for page-backed tiles — turns the name into a destination menu. */
  url?: string;
  onPick?: (url: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  /** Omitted for the primary tile, which must always exist. */
  onClose?: () => void;
  headerLeft?: ReactNode;
  /**
   * Lift the buttons out of the header's flow and pin them to its top-right.
   *
   * For a one-row header they'd sit there anyway, so this is only set by the
   * tile whose header content is TALLER than one row — the primary tile, which
   * hands in the app's two-row tab strip. In normal flow the buttons take
   * their width out of both rows, and the second row is the crowded one: it
   * lost enough space to start clipping tab labels. Pinned, they overlap only
   * the first row, which reserves room for them (Workspace.module.css).
   */
  overlayActions?: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-away and Escape. Bound only while the menu is up, so the workspace
  // isn't carrying a document listener per tile the whole time it's open.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <section className={styles.panel}>
      <header className={[styles.head, overlayActions ? styles.headOverlay : ""].filter(Boolean).join(" ")}>
        {headerLeft ?? (
          url && onPick ? (
            <div className={styles.pickWrap} ref={menuRef}>
              <button
                type="button"
                className={styles.pick}
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                title={url}
              >
                {destinationLabel(url)} &#9662;
              </button>
              {menuOpen ? (
                <div className={styles.menu} role="menu">
                  {DESTINATIONS.map((g) => (
                    <div key={g.group} className={styles.group}>
                      <div className={styles.groupLabel}>{g.group}</div>
                      {g.items.map((d) => (
                        <button
                          key={d.url}
                          type="button"
                          role="menuitem"
                          className={styles.menuItem}
                          onClick={() => {
                            onPick(d.url);
                            setMenuOpen(false);
                          }}
                        >
                          <span className={styles.menuIcon}>{d.icon}</span>
                          {d.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <span className={styles.title}>{title}</span>
          )
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={onSplitRight} title="Split beside this" aria-label="Split beside this">
            <SplitRightIcon />
          </button>
          <button type="button" className={styles.action} onClick={onSplitDown} title="Split below this" aria-label="Split below this">
            <SplitDownIcon />
          </button>
          {onClose ? (
            <button type="button" className={styles.action} onClick={onClose} title="Close this panel" aria-label="Close this panel">
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
