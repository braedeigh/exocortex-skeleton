import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TerminalPane } from './TerminalPane';
import { FakeTerminal } from './FakeTerminal';
import { KeeperPane } from './KeeperPane';
import { useSessions } from './useSessions';
import { useChatSurfaceObservatory, setChatSurfaceObservatory } from './chatSurface';
import { registerPaneConversationTarget } from './paneConversation';
import { useLeftPaneHistory } from './paneHistory';
import { usePaneSwipeBack } from './usePaneSwipeBack';
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
 * Observatory (the roster) / the open session, tab-labelled with its own title /
 * Terminal. Three plain tabs rather than the phone's tap-the-active-tab-again
 * gesture: there's room for them here, and a hidden gesture on a mouse surface
 * is just a hidden feature.
 *
 * The middle tab wears the conversation's name rather than a fixed word: the
 * roster tab is the one that means "the Observatory in general", so repeating
 * that word on the tab beside it named nothing. The title is reported up from
 * the room (see roomTitle below) and ellipsized by CSS when it's long.
 *
 * Terminal-vs-room writes the SAME localStorage flag the mobile Chat tab
 * reads (chatSurface.ts) rather than inventing a second knob, so "which
 * surface is my chat" stays one answer per device, settable from Settings or
 * from the pane itself. Where she is INSIDE the observatory is a different
 * kind of thing — a place, not a preference — and it lives in a location
 * stack (paneHistory.ts) that this component owns and hands down.
 *
 * THE PANE GOES BACK (07-31). Because that stack remembers, the pane has a
 * back: the ‹ at the left of the switcher, and a two-finger swipe-right
 * anywhere over this half (usePaneSwipeBack.ts). The swipe works by the pane
 * refusing to chain its horizontal overscroll out to the browser — see
 * .leftGestured in the stylesheet — so the same gesture over the RIGHT half is
 * still an ordinary browser back, and nothing has to track which half the
 * cursor is over. The tabs alone could never do this: they get you between the
 * roster and the room, but not back to the conversation you were reading two
 * before this one.
 *
 * With nothing left to go back to, the swipe falls through to the browser's
 * back rather than dying silently — the gesture always means something.
 *
 * The switcher isn't the only thing that writes that flag: a feature pushing
 * a session at the terminal (see the exo:set-session effect below) flips it
 * to Terminal too, so the pane surfaces itself when something needs to be
 * seen there. The terminal has stopped being a place she goes and become a
 * place things arrive.
 *
 * The room arrives at the same way: a page in the RIGHT half can hand this
 * pane a conversation to open (paneConversation.ts — the terrain map's agent
 * orbs do), which reveals the room and pushes that conversation as the pane's
 * new location. The right half keeps whatever it was showing, so tapping an
 * agent on the map reads its session BESIDE the map rather than replacing it —
 * and because it's a pushed location, the back above returns her to whatever
 * she was reading before the map interrupted.
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
  const keeperPane = useChatSurfaceObservatory();
  // Where the pane is inside the observatory, and everywhere it's been
  // (paneHistory.ts). Opens on the roster (her 07-27 ask) — the pane lands on
  // the Observatory in general, not straight into the Keeper conversation.
  const { here, push, back, canGoBack, canGoBackRef } = useLeftPaneHistory(terminalEnabled);
  const roster = here.roster;
  // The open conversation's own title, reported up by the room (KeeperPane ->
  // ObservatoryPage). null until it resolves, and again for the moment between
  // conversations. It's what the second tab is LABELLED — a tab that just says
  // "Observatory" tells her nothing the first tab doesn't; the session's name
  // tells her which room the switch would put her back into.
  const [roomTitle, setRoomTitle] = useState<string | null>(null);
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
  const leftRef = useRef<HTMLDivElement>(null);

  // The pane's back, shared by the ‹ and the swipe. Reads the ref rather than
  // `canGoBack` because the swipe's DOM listener is bound once and would
  // otherwise close over whatever the flag was at bind time.
  const goBack = useCallback(() => {
    if (canGoBackRef.current) back();
    // Nothing left in this half — let the gesture mean what it always meant.
    else window.history.back();
  }, [back, canGoBackRef]);

  usePaneSwipeBack({ ref: leftRef, enabled: terminalEnabled, onBack: goBack });

  // Every "open this conversation" inside the room is one move now — a roster
  // card, a fresh compose's first send, a rollover. The location carries both
  // "that session" and "not the roster", so where the request came from stopped
  // mattering.
  const openConversation = useCallback((id: string) => push({ roster: false, conv: id }), [push]);

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

  // Other features push the docked terminal at a named tmux session —
  // research's "follow live", and "talk to this thread" from the threads
  // pages and the journal's thread popover. This instance owns desktop
  // session state, so the request arrives as a window event rather than
  // through context.
  //
  // Pushing a session also REVEALS the terminal (flips the surface flag),
  // because the terminal isn't a surface anyone navigates to any more — the
  // conversation lives in the observatory. Without this, thread-talk spawned
  // its claude session and switched the pane to it underneath a hidden
  // observatory: running, invisible, and only findable by guessing that the
  // Terminal tab had something new in it. Clicking back to Sessions or
  // Observatory puts it away again.
  const { setActive } = sessions;
  useEffect(() => {
    if (!terminalEnabled) return;
    function onSetSession(e: Event) {
      const name = (e as CustomEvent).detail;
      if (typeof name === 'string' && name) {
        setActive(name);
        setChatSurfaceObservatory(false);
      }
    }
    window.addEventListener('exo:set-session', onSetSession);
    return () => window.removeEventListener('exo:set-session', onSetSession);
  }, [terminalEnabled, setActive]);

  // "Open this conversation here" from the right half. Only claimed while the
  // authed desktop pane actually exists — on mobile and in public mode nothing
  // registers, so the caller learns it has to navigate instead. Surfacing it
  // takes two moves now: push the conversation as the pane's location (which
  // is both "that session" and "not the roster" in one value), and reveal the
  // room rather than the terminal.
  useEffect(() => {
    if (!terminalEnabled) return;
    return registerPaneConversationTarget((convId) => {
      push({ roster: false, conv: convId });
      setChatSurfaceObservatory(true);
    });
  }, [terminalEnabled, push]);

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
      <div
        className={[styles.left, terminalEnabled ? styles.leftGestured : ''].filter(Boolean).join(' ')}
        style={{ flexBasis: `${width}%` }}
        ref={leftRef}
      >
        {isPublic ? (
          <FakeTerminal onCollapse={() => setCollapsed(true)} />
        ) : (
          <div className={styles.paneStack}>
            <div className={styles.paneSwitch}>
              {/* Always rendered, dimmed when there's nowhere to go — a control
                  that appears and disappears would shove the three tabs
                  sideways every time she opened a second conversation. Outside
                  the tablist below because it isn't one of the tabs: it moves
                  within the room rather than choosing a surface — which is also
                  why it's dead while the Terminal is up: the history it walks
                  is the observatory's, and stepping through it behind a
                  terminal would move something she can't see. */}
              <button
                type="button"
                className={styles.paneBack}
                disabled={!keeperPane || !canGoBack}
                title={keeperPane && canGoBack ? 'Back in this pane' : 'Nothing to go back to'}
                aria-label="Back in this pane"
                onClick={back}
              >
                &#8249;
              </button>
              <div className={styles.paneTabs} role="tablist" aria-label="Left pane">
                <button
                  type="button"
                  role="tab"
                  aria-selected={keeperPane && roster}
                  className={[styles.paneTab, keeperPane && roster ? styles.paneTabActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  title="Every observatory session"
                  onClick={() => {
                    push({ roster: true });
                    setChatSurfaceObservatory(true);
                  }}
                >
                  Observatory
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={keeperPane && !roster}
                  className={[styles.paneTab, keeperPane && !roster ? styles.paneTabActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  title={roomTitle ?? 'The open conversation'}
                  onClick={() => {
                    push({ roster: false });
                    setChatSurfaceObservatory(true);
                  }}
                >
                  {roomTitle ?? 'Session'}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!keeperPane}
                  className={[styles.paneTab, !keeperPane ? styles.paneTabActive : ''].filter(Boolean).join(' ')}
                  title="The tmux terminal"
                  onClick={() => setChatSurfaceObservatory(false)}
                >
                  Terminal
                </button>
              </div>
            </div>
            {visited.has('terminal') ? (
              <div className={keeperPane ? styles.paneSlotHidden : styles.paneSlot}>
                <TerminalPane sessions={sessions} />
              </div>
            ) : null}
            {visited.has('keeper') ? (
              <div className={keeperPane ? styles.paneSlot : styles.paneSlotHidden}>
                <KeeperPane
                  roster={roster}
                  conv={here.conv}
                  onOpenConversation={openConversation}
                  onRoomTitle={setRoomTitle}
                />
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
