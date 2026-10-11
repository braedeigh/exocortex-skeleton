import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FakeTerminal } from './FakeTerminal';
import { Workspace } from './panels/Workspace';
import { useMediaQuery, DESKTOP_QUERY } from './useMediaQuery';
import { isSolo } from './solo';
import styles from './SplitLayout.module.css';

/**
 * SplitLayout.tsx — decides WHICH of the three shells this window gets, and
 * owns only the simplest one itself.
 *
 * - A solo window (`?solo=1`, shell/solo.ts): none of them. The routed
 *   content gets the whole window, with no chrome at all.
 * - Mobile (under 769px): no split at all. The routed content fills the
 *   window, exactly as it always has.
 * - Desktop, signed in: the tiling workspace (panels/Workspace.tsx) — as many
 *   resizable panels as you want, each with its own tab bar, opening on the
 *   Observatory beside the routed content. The routed content passed in as
 *   `children` becomes the workspace's primary panel. `chrome` (the fixed tab
 *   strip) is NOT used here: panels carry their own.
 * - Desktop, public visitor: the old fixed two-box split, kept here in full.
 *   A visitor gets the intro pane and the dashboard, and no reason to
 *   rearrange anything — so the workspace, its storage, and its chrome never
 *   load for them. The intro pane collapses to a slim rail (the button lives
 *   in FakeTerminal, via onCollapse), and the divider position persists as a
 *   percentage in localStorage.
 *
 * Touches: panels/Workspace.tsx (the authed desktop shell), FakeTerminal.tsx
 * (the public one), solo.ts (the solo flag), routes/__root.tsx (mounts this).
 */

const WIDTH_KEY = 'exo-split-width';
const MIN_PCT = 20;
const MAX_PCT = 80;
const COLLAPSE_KEY = 'exo-intro-collapsed';

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_PCT && raw <= MAX_PCT) return raw;
  } catch {
    // ignore
  }
  return 50;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function SplitLayout({ chrome, children }: { chrome: ReactNode; children: ReactNode }) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';

  const [width, setWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const containerRef = useRef<HTMLDivElement>(null);

  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

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

  if (isSolo()) {
    // Give a solo window the page and nothing else. A file popped out of the
    // Terrain map (shell/solo.ts) is its own browser tab whose whole point
    // is one pane — so no workspace, no tiles restored from the last layout,
    // and no tab strip. Checked before everything else so it holds at any
    // width: dragging the window narrow must not bring the mobile tabs back.
    return (
      <div className={styles.container} ref={containerRef}>
        <div className={styles.right}>{children}</div>
      </div>
    );
  }

  if (!isDesktop) {
    // Mobile: no split — content fills, exactly as before.
    return (
      <div className={styles.container} ref={containerRef}>
        <div className={styles.right}>{chrome}{children}</div>
      </div>
    );
  }

  if (!isPublic) {
    // Signed in on a desktop: the tiling workspace owns the whole window, and
    // builds its own chrome — every panel carries its own tab bar, so the
    // fixed strip `chrome` holds is only for mobile and public visitors.
    return <Workspace>{children}</Workspace>;
  }

  if (window.PUBLIC_ONLY) {
    // The public-only mirror is a portfolio with one exhibit, the Terrain map
    // (public_config.PRESENTABLE_PATHS): it gets the whole window, no intro
    // pane. The about copy lives on the static page at the apex domain.
    return (
      <div className={styles.container} ref={containerRef}>
        <div className={styles.right}>{chrome}{children}</div>
      </div>
    );
  }

  // Collapsed state of the public split — replaces the intro pane and its
  // divider with a slim vertical tab pinned to the left edge.
  if (collapsed) {
    return (
      <div className={[styles.container, dragging ? styles.dragging : ''].filter(Boolean).join(' ')} ref={containerRef}>
        <button
          type="button"
          className={styles.rail}
          aria-expanded={false}
          title="Show intro"
          onClick={() => setCollapsed(false)}
        >
          <span className={styles.railMark}>&#9670;</span> about me
        </button>
        <div className={styles.right}>{chrome}{children}</div>
      </div>
    );
  }

  return (
    <div className={[styles.container, dragging ? styles.dragging : ''].filter(Boolean).join(' ')} ref={containerRef}>
      <div className={styles.left} style={{ flexBasis: `${width}%` }}>
        <FakeTerminal onCollapse={() => setCollapsed(true)} />
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
      <div className={styles.right}>{chrome}{children}</div>
      {dragging && <div className={styles.dragOverlay} />}
    </div>
  );
}
