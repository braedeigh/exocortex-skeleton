import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TerminalPane } from './TerminalPane';
import { FakeTerminal } from './FakeTerminal';
import { KeeperPane } from './KeeperPane';
import { useSessions } from './useSessions';
import { useChatSurfaceReadingRoom, setChatSurfaceReadingRoom } from './chatSurface';
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
 *
 * Desktop public visitors can also collapse the FakeTerminal pane entirely
 * (via the control cluster it renders — see FakeTerminal's onCollapse prop)
 * into a slim vertical rail pinned to the left edge, persisted the same way
 * as the divider width. This is public-only: authed users' TerminalPane has
 * no collapse affordance and this state is never consulted for them.
 *
 * WHAT'S IN THE LEFT PANE (07-25): for authed desktop it's the whole reading
 * room plus the tmux terminal, picked by a switcher at the top of the pane —
 * Sessions (the roster) / Reading room (the open conversation) / Terminal.
 * Three plain tabs rather than the phone's tap-the-active-tab-again gesture:
 * there's room for them here, and a hidden gesture on a mouse surface is just
 * a hidden feature.
 *
 * Terminal-vs-room writes the SAME localStorage flag the mobile Chat tab
 * reads (chatSurface.ts) rather than inventing a second knob, so "which
 * surface is my chat" stays one answer per device, settable from Settings or
 * from the pane itself. Which reading-room *view* is showing is pane-local
 * state — it's a place in the room, not a preference.
 *
 * The terminal and the room both stay mounted once visited and toggle by CSS
 * — same reasoning as TerminalFrames: remounting drops ttyd's websocket, and
 * it would also throw away a reply the Keeper is mid-stream on.
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

export function SplitLayout({ children }: { children: ReactNode }) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPublic = typeof window !== 'undefined' && window.VIEW_MODE === 'public';
  const terminalEnabled = isDesktop && !isPublic;

  const sessions = useSessions(terminalEnabled);
  // Which of the two authed surfaces the left pane is showing. Not its own
  // state: it IS the chat-surface flag (see the header comment), so flipping
  // it in Settings moves this pane and vice versa.
  const keeperPane = useChatSurfaceReadingRoom();
  // Which view of the room is up: the roster or the open conversation.
  const [roster, setRoster] = useState(false);
  const openRoom = useCallback(() => setRoster(false), []);
  // Mount-on-first-visit, then keep mounted (see header) — starts with
  // whichever surface the flag opens on.
  const [visited, setVisited] = useState<ReadonlySet<'keeper' | 'terminal'>>(
    () => new Set([keeperPane ? 'keeper' : 'terminal'] as const),
  );
  useEffect(() => {
    const pane = keeperPane ? 'keeper' : 'terminal';
    setVisited((prev) => (prev.has(pane) ? prev : new Set([...prev, pane])));
  }, [keeperPane]);
  const [width, setWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);
  // Lazily read like readWidth() above. Harmless to read for authed users
  // too (the value just never gets consulted in their render path below).
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

  // Other features can flip the docked terminal to a named tmux session
  // (research's "follow live") — this instance owns desktop session state,
  // so the request arrives as a window event rather than through context.
  const { setActive } = sessions;
  useEffect(() => {
    if (!terminalEnabled) return;
    function onSetSession(e: Event) {
      const name = (e as CustomEvent).detail;
      if (typeof name === 'string' && name) setActive(name);
    }
    window.addEventListener('exo:set-session', onSetSession);
    return () => window.removeEventListener('exo:set-session', onSetSession);
  }, [terminalEnabled, setActive]);

  if (!isDesktop) {
    // Mobile: no split — content fills, exactly as before.
    return (
      <div className={styles.container} ref={containerRef}>
        <div className={styles.right}>{children}</div>
      </div>
    );
  }

  // Collapsed rail only ever applies to the desktop public split — authed
  // desktop always falls through to the normal left pane + divider below,
  // regardless of what's in localStorage.
  if (isPublic && collapsed) {
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
        <div className={styles.right}>{children}</div>
      </div>
    );
  }

  return (
    <div className={[styles.container, dragging ? styles.dragging : ''].filter(Boolean).join(' ')} ref={containerRef}>
      <div className={styles.left} style={{ flexBasis: `${width}%` }}>
        {isPublic ? (
          <FakeTerminal onCollapse={() => setCollapsed(true)} />
        ) : (
          <div className={styles.paneStack}>
            <div className={styles.paneSwitch} role="tablist" aria-label="Left pane">
              <button
                type="button"
                role="tab"
                aria-selected={keeperPane && roster}
                className={[styles.paneTab, keeperPane && roster ? styles.paneTabActive : '']
                  .filter(Boolean)
                  .join(' ')}
                title="Every reading-room session"
                onClick={() => {
                  setRoster(true);
                  setChatSurfaceReadingRoom(true);
                }}
              >
                Sessions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={keeperPane && !roster}
                className={[styles.paneTab, keeperPane && !roster ? styles.paneTabActive : '']
                  .filter(Boolean)
                  .join(' ')}
                title="The open conversation"
                onClick={() => {
                  setRoster(false);
                  setChatSurfaceReadingRoom(true);
                }}
              >
                Reading room
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!keeperPane}
                className={[styles.paneTab, !keeperPane ? styles.paneTabActive : ''].filter(Boolean).join(' ')}
                title="The tmux terminal"
                onClick={() => setChatSurfaceReadingRoom(false)}
              >
                Terminal
              </button>
            </div>
            {visited.has('terminal') ? (
              <div className={keeperPane ? styles.paneSlotHidden : styles.paneSlot}>
                <TerminalPane sessions={sessions} />
              </div>
            ) : null}
            {visited.has('keeper') ? (
              <div className={keeperPane ? styles.paneSlot : styles.paneSlotHidden}>
                <KeeperPane roster={roster} onOpenRoom={openRoom} />
              </div>
            ) : null}
          </div>
        )}
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
