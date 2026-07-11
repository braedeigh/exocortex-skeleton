import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TerminalPane } from './TerminalPane';
import { FakeTerminal } from './FakeTerminal';
import { useSessions } from './useSessions';
import { useMediaQuery, DESKTOP_QUERY } from './useMediaQuery';
import styles from './SplitLayout.module.css';

/**
 * Desktop split screen — the React port of split.html's `.split-container`
 * (terminal pane | draggable divider | dashboard pane, templates/split.html:
 * 505-570). The right pane is the SPA's normal routed content (FrameHost +
 * the router Outlet), passed in as children, so navigation is unchanged.
 *
 * The real terminal pane only mounts on desktop (>=769px) and only for authed
 * users — mirroring split.html, where `.split-container` is display:none
 * under 768px and the terminal never loads for public visitors. Desktop
 * *public* visitors keep the split, but the left pane is the FakeTerminal
 * (the old public mode's `.cc-fake` intro) — no sessions are polled and
 * nothing private mounts. On mobile the children render full-bleed exactly
 * as before this component existed.
 *
 * Divider position is a percentage persisted to localStorage so a resize
 * sticks across reloads.
 */

const WIDTH_KEY = 'exo-split-width';
const MIN_PCT = 20;
const MAX_PCT = 80;

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_PCT && raw <= MAX_PCT) return raw;
  } catch {
    // ignore
  }
  return 50;
}

export function SplitLayout({ children }: { children: ReactNode }) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';
  const terminalEnabled = isDesktop && !isPublic;

  const sessions = useSessions(terminalEnabled);
  const [width, setWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setWidth(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)));
  }, []);

  const endDrag = useCallback(() => {
    setDragging(false);
    setWidth((w) => {
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
      } catch {
        // ignore
      }
      return w;
    });
  }, []);

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
    };
  }, [dragging, onPointerMove, endDrag]);

  if (!isDesktop) {
    // Mobile: no split — content fills, exactly as before.
    return (
      <div className={styles.container} ref={containerRef}>
        <div className={styles.right}>{children}</div>
      </div>
    );
  }

  return (
    <div className={[styles.container, dragging ? styles.dragging : ''].filter(Boolean).join(' ')} ref={containerRef}>
      <div className={styles.left} style={{ flexBasis: `${width}%` }}>
        {isPublic ? <FakeTerminal /> : <TerminalPane sessions={sessions} />}
      </div>
      <div
        className={styles.divider}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
      />
      <div className={styles.right}>{children}</div>
      {dragging && <div className={styles.dragOverlay} />}
    </div>
  );
}
