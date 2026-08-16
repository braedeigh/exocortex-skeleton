import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TerminalPane } from '../TerminalPane';
import { KeeperPane } from '../KeeperPane';
import { useSessions } from '../useSessions';
import { useChatSurfaceObservatory, setChatSurfaceObservatory } from '../chatSurface';
import { registerPaneConversationTarget } from '../paneConversation';
import { useLeftPaneHistory } from '../paneHistory';
import { usePaneSwipeBack } from '../usePaneSwipeBack';
import styles from './PaneStack.module.css';

/**
 * PaneStack.tsx — the reading room as a tile: Observatory, the open session,
 * and the Terminal, with the switcher that picks between them and the back
 * that walks where the pane has been.
 *
 * This is the old left box, lifted out of SplitLayout.tsx unchanged in
 * behaviour so it can be ONE tile in a workspace of many rather than a
 * hardcoded half of the screen. Everything it used to do it still does: the
 * three surfaces stay mounted once visited and toggle by CSS (remounting drops
 * the terminal's connection and would throw away a reply mid-stream), the
 * two-finger swipe-right over this tile is its own back, and other features
 * can push a session or a conversation at it.
 *
 * It hands back its header and its body SEPARATELY, because the workspace
 * draws the header row for every tile — so the three tabs sit in that shared
 * row instead of stacking a second strip of chrome under it.
 *
 * WHAT HAPPENS IF THIS TILE ISN'T OPEN. Nothing registers: the conversation
 * target isn't claimed and the session event isn't listened for, so the
 * features that push work here learn there's nowhere to push and navigate
 * instead. That fallback already existed for mobile, where this tile never
 * exists at all.
 *
 * Touches: paneHistory.ts (where the tile is), chatSurface.ts (terminal vs
 * room), paneConversation.ts (pushes in from another tile),
 * usePaneSwipeBack.ts (the gesture), Workspace.tsx (the only caller).
 */
export function usePaneStack(enabled: boolean): { header: ReactNode; body: ReactNode } {
  const sessions = useSessions(enabled);
  // Which surface is showing. Not local state: it IS the shared chat-surface
  // flag, so flipping it in Settings moves this tile and vice versa.
  const keeperPane = useChatSurfaceObservatory();
  const { here, push, back, canGoBack, canGoBackRef } = useLeftPaneHistory(enabled);
  const roster = here.roster;
  // The open conversation's own title, reported up by the room — it's what the
  // middle tab is labelled, since a tab reading "Observatory" beside the
  // roster tab would name nothing.
  const [roomTitle, setRoomTitle] = useState<string | null>(null);
  // Mount-on-first-visit, then keep mounted (see the header note).
  const [visited, setVisited] = useState<ReadonlySet<'keeper' | 'terminal'>>(
    () => new Set([keeperPane ? 'keeper' : 'terminal'] as const),
  );
  useEffect(() => {
    const pane = keeperPane ? 'keeper' : 'terminal';
    setVisited((prev) => (prev.has(pane) ? prev : new Set([...prev, pane])));
  }, [keeperPane]);

  const bodyRef = useRef<HTMLDivElement>(null);

  // The tile's back, shared by the ‹ and the swipe. Reads the ref rather than
  // the flag because the swipe's DOM listener is bound once and would
  // otherwise close over whatever the flag was at bind time.
  const goBack = useCallback(() => {
    if (canGoBackRef.current) back();
    // Nothing left in this tile — let the gesture mean what it always meant.
    else window.history.back();
  }, [back, canGoBackRef]);

  usePaneSwipeBack({ ref: bodyRef, enabled, onBack: goBack });

  const openConversation = useCallback((id: string) => push({ roster: false, conv: id }), [push]);

  // Other features push the docked terminal at a named session — research's
  // "follow live", and "talk to this thread". Pushing also REVEALS the
  // terminal, because otherwise the session runs invisibly behind whichever
  // surface happened to be up.
  const { setActive } = sessions;
  useEffect(() => {
    if (!enabled) return;
    function onSetSession(e: Event) {
      const name = (e as CustomEvent).detail;
      if (typeof name === 'string' && name) {
        setActive(name);
        setChatSurfaceObservatory(false);
      }
    }
    window.addEventListener('exo:set-session', onSetSession);
    return () => window.removeEventListener('exo:set-session', onSetSession);
  }, [enabled, setActive]);

  // "Open this conversation here", pushed in from another tile (the terrain
  // map's agent orbs do this). Two moves: push the conversation as this tile's
  // location, and reveal the room rather than the terminal.
  useEffect(() => {
    if (!enabled) return;
    return registerPaneConversationTarget((convId) => {
      push({ roster: false, conv: convId });
      setChatSurfaceObservatory(true);
    });
  }, [enabled, push]);

  const header = (
    <div className={styles.switch}>
      {/* Always rendered, dimmed when there's nowhere to go — a control that
          appeared and disappeared would shove the tabs sideways every time a
          second conversation opened. Outside the tablist because it isn't one
          of the tabs: it moves within the room rather than choosing a surface,
          which is also why it's dead while the Terminal is up. */}
      <button
        type="button"
        className={styles.back}
        disabled={!keeperPane || !canGoBack}
        title={keeperPane && canGoBack ? 'Back in this pane' : 'Nothing to go back to'}
        aria-label="Back in this pane"
        onClick={back}
      >
        &#8249;
      </button>
      <div className={styles.tabs} role="tablist" aria-label="Reading room">
        <button
          type="button"
          role="tab"
          aria-selected={keeperPane && roster}
          className={[styles.tab, keeperPane && roster ? styles.tabActive : ''].filter(Boolean).join(' ')}
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
          className={[styles.tab, keeperPane && !roster ? styles.tabActive : ''].filter(Boolean).join(' ')}
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
          className={[styles.tab, !keeperPane ? styles.tabActive : ''].filter(Boolean).join(' ')}
          title="The tmux terminal"
          onClick={() => setChatSurfaceObservatory(false)}
        >
          Terminal
        </button>
      </div>
    </div>
  );

  const body = (
    <div className={styles.body} ref={bodyRef}>
      {visited.has('terminal') ? (
        <div className={keeperPane ? styles.slotHidden : styles.slot}>
          <TerminalPane sessions={sessions} />
        </div>
      ) : null}
      {visited.has('keeper') ? (
        <div className={keeperPane ? styles.slot : styles.slotHidden}>
          <KeeperPane
            roster={roster}
            conv={here.conv}
            onOpenConversation={openConversation}
            onRoomTitle={setRoomTitle}
          />
        </div>
      ) : null}
    </div>
  );

  return { header, body };
}
