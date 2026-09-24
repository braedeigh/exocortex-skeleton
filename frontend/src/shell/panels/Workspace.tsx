import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { TopTabs } from '../TopTabs';
import { PanelTree } from './PanelTree';
import { RoutePanel } from './RoutePanel';
import { TabBar } from './TabBar';
import { pathOf, sectionForUrl } from './sections';
import { usePaneStack } from './PaneStack';
import {
  closePanel,
  listPanels,
  resizeSplit,
  setPanelSet,
  setPanelTabs,
  setPanelUrl,
  splitPanel,
  type PanelNode,
} from './layoutTree';
import { openTab, type OpenTab } from './panelTabs';
import { newId, newRoutePanel, useLayout } from './panelStore';
import { routeConversation, windowAcceptsConversations } from './conversationRouting';
import { routeActivity } from './activityRouting';
import { registerIntentTarget } from './windowBus';
import styles from './Workspace.module.css';

/**
 * Workspace.tsx — the tiling desktop: however many panels you want, arranged
 * however you like, resizable, each with its own tabs, and remembered.
 *
 * It opens on the Observatory beside the routed content. Every panel header
 * carries a tab bar (TabBar.tsx) and the same three moves — split beside,
 * split below, close — and the boundaries drag.
 *
 * THE KINDS OF PANEL, and why there's more than one:
 *
 * - A ROUTE panel is any page in the app running on its own private address
 *   bar (RoutePanel.tsx). This is the ordinary kind, and the one that lets the
 *   terrain map and a code file be open at once, or two conversations.
 * - The PRIMARY panel is the one wired to the browser's real address bar, the
 *   back button, and every existing link. There is exactly one and it can't be
 *   closed. Keeping it intact is why nothing else in the app had to change.
 * - The READING ROOM panel is the old left box — Observatory / session /
 *   Terminal behind one switcher (PaneStack.tsx). It's no longer in the default
 *   arrangement: it bundles a terminal she doesn't use and is the one panel
 *   that can't be opened twice. Kept because saved layouts may still hold one.
 *
 * WHAT'S PER PANEL vs PER WINDOW vs SHARED. The arrangement and which tab set
 * each panel wears are per WINDOW (panelStore.ts) — that's what lets two
 * monitors be set up differently. The tab sets themselves are SHARED, from the
 * vault (useTabSets.ts), so both windows and the phone offer the same two.
 *
 * Touches: layoutTree.ts (the operations), PanelTree.tsx (draws it),
 * panelStore.ts (remembers it), TabBar.tsx (each header), SplitLayout.tsx
 * (mounts it on authed desktop).
 */
export function Workspace({ children }: { children: ReactNode }) {
  const [layout, setLayout] = useLayout();
  const [dragging, setDragging] = useState(false);
  const navigate = useNavigate();
  // The primary panel's tab bar has to reflect the REAL address bar, so it
  // reads the router rather than the layout tree.
  const href = useRouterState({ select: (s) => s.location.href });

  // The reading room is only wired up when a saved layout still has one. Its
  // hooks always run (hooks can't be conditional), but everything they
  // register is gated on this, so with no such panel the features that push
  // work at it fall back to navigating.
  const paneOpen = useMemo(() => listPanels(layout).some((p) => p.kind === 'pane'), [layout]);
  const pane = usePaneStack(paneOpen);

  const onSplit = useCallback(
    (panelId: string, dir: 'row' | 'col') => {
      setLayout((cur) => {
        const from = listPanels(cur).find((p) => p.id === panelId);
        return splitPanel(cur, panelId, dir, newRoutePanel(from?.setId), newId('split'));
      });
    },
    [setLayout],
  );

  const onClose = useCallback((panelId: string) => setLayout((cur) => closePanel(cur, panelId)), [setLayout]);

  const onPick = useCallback(
    (panelId: string, url: string) => setLayout((cur) => setPanelUrl(cur, panelId, url)),
    [setLayout],
  );

  const onSetId = useCallback(
    (panelId: string, setId: string) => setLayout((cur) => setPanelSet(cur, panelId, setId)),
    [setLayout],
  );

  const onOpenTabs = useCallback(
    (panelId: string, tabs: OpenTab[]) => setLayout((cur) => setPanelTabs(cur, panelId, tabs)),
    [setLayout],
  );

  /* ARRIVING SOMEWHERE IS WHAT OPENS A TAB. However a panel got there — a tab
     clicked, a session picked out of the roster, a link inside a page — the
     page she's now looking at is by definition one she's using, so it earns a
     tab. That's what fills the bar as she works instead of making her ask for
     it, and it's why clicking a session in the roster is all it takes.

     A section's own front page is excluded: its anchor already stands for it,
     and a second tab beside the anchor saying the same thing is just noise. */
  const rememberArrival = useCallback(
    (panelId: string, url: string) => {
      setLayout((cur) => {
        const panel = listPanels(cur).find((p) => p.id === panelId);
        if (!panel) return cur;
        const section = sectionForUrl(url);
        if (section && pathOf(section.home) === pathOf(url)) return cur;
        return setPanelTabs(cur, panelId, openTab(panel.tabs ?? [], url, Date.now()));
      });
    },
    [setLayout],
  );

  /** A panel moved itself (a link, the roster) — record where it landed. */
  const onPanelUrlChanged = useCallback(
    (panelId: string, url: string) => {
      onPick(panelId, url);
      rememberArrival(panelId, url);
    },
    [onPick, rememberArrival],
  );

  /** Something in the bar was clicked. */
  const navigatePanel = useCallback(
    (panelId: string, url: string, isPrimary: boolean) => {
      if (isPrimary) void navigate({ to: url });
      else onPick(panelId, url);
      rememberArrival(panelId, url);
    },
    [navigate, onPick, rememberArrival],
  );

  const onResize = useCallback(
    (splitId: string, boundary: number, deltaPct: number) =>
      setLayout((cur) => resizeSplit(cur, splitId, boundary, deltaPct)),
    [setLayout],
  );

  /* WHERE A CONVERSATION OPENS is a decision about the whole window, so the
     workspace registers ONE window-level catcher and rules with
     conversationRouting.ts: already visible → flash it; a background tab →
     switch to it; an observatory panel up → it takes the tab; none anywhere →
     a new pane is born at half the window. Tiles stopped catching
     conversations for themselves (panelIntents.ts) so nothing shadows this.

     The catcher registers only when the window has observatory presence at
     all — a pure watching window (terrain + flow, no observatory panel or
     tab) stays quiet and the bus carries conversations to a window that
     qualifies. And when a saved layout still holds the legacy reading room,
     that pane keeps its own conversation seam (PaneStack) and this defers.

     Prompt: "it will check if it's already an open pane in the window, and if
     not, it opens another pane … it should open a new pane if there is no
     observatory tab anywhere on that page". */
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const flashPanel = useCallback((panelId: string) => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlashId(panelId);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlashId(null);
    }, 1200);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  // The handler outlives renders (registration churn would drop cross-window
  // announcements), so it reads the live tree and href through refs.
  const latest = useRef({ layout, href });
  latest.current = { layout, href };
  const accepts = useMemo(() => windowAcceptsConversations(layout, href), [layout, href]);
  useEffect(() => {
    if (paneOpen || !accepts) return;
    const { unregister } = registerIntentTarget(['conversation'], (intent) => {
      if (intent.kind !== 'conversation') return;
      const { layout: tree, href: primaryHref } = latest.current;
      const action = routeConversation(tree, intent.convId, primaryHref);
      if (!action) return;
      if (action.kind === 'reveal') {
        flashPanel(action.panelId);
        return;
      }
      if (action.kind === 'show') {
        if (action.isPrimary) void navigate({ to: action.url });
        else onPick(action.panelId, action.url);
        rememberArrival(action.panelId, action.url);
        flashPanel(action.panelId);
        return;
      }
      // 'split' — a new pane, born already on the conversation and carrying
      // it as its open tab. Direction from the window's own shape: wide
      // windows split beside, tall ones below — either way the newcomer takes
      // half, which is what keeps "big enough to read all the text" true.
      const panelId = newId('panel');
      const dir = window.innerWidth >= window.innerHeight ? 'row' : 'col';
      const from = listPanels(tree).find((p) => p.id === action.targetId);
      setLayout((cur) =>
        splitPanel(
          cur,
          action.targetId,
          dir,
          {
            type: 'panel',
            id: panelId,
            kind: 'route',
            url: action.url,
            tabs: [{ url: action.url, at: Date.now() }],
            ...(from?.setId ? { setId: from.setId } : {}),
          },
          newId('split'),
        ),
      );
      flashPanel(panelId);
    });
    return unregister;
  }, [paneOpen, accepts, navigate, onPick, rememberArrival, setLayout, flashPanel]);

  /* WHERE A SESSION'S ACTIVITY OPENS: beside the session, as its own pane.
     The session toolbar's "activity" button sends the request; the rule is
     in activityRouting.ts — already showing it → flash that panel; an
     activity panel for another session → it switches over; otherwise a new
     pane is born to the right of the conversation. Every desktop window
     registers this, so the click lands in the window it came from. */
  useEffect(() => {
    const { unregister } = registerIntentTarget(['activity'], (intent) => {
      if (intent.kind !== 'activity') return;
      const { layout: tree, href: primaryHref } = latest.current;
      const action = routeActivity(tree, intent.convId, primaryHref);
      if (!action) return;
      if (action.kind === 'reveal') {
        flashPanel(action.panelId);
        return;
      }
      if (action.kind === 'show') {
        if (action.isPrimary) void navigate({ to: action.url });
        else onPick(action.panelId, action.url);
        rememberArrival(action.panelId, action.url);
        flashPanel(action.panelId);
        return;
      }
      const panelId = newId('panel');
      const from = listPanels(tree).find((p) => p.id === action.targetId);
      setLayout((cur) =>
        splitPanel(
          cur,
          action.targetId,
          'row',
          {
            type: 'panel',
            id: panelId,
            kind: 'route',
            url: action.url,
            tabs: [{ url: action.url, at: Date.now() }],
            ...(from?.setId ? { setId: from.setId } : {}),
          },
          newId('split'),
        ),
      );
      flashPanel(panelId);
    });
    return unregister;
  }, [navigate, onPick, rememberArrival, setLayout, flashPanel]);

  const renderContent = useCallback(
    (panel: PanelNode): ReactNode => {
      let body: ReactNode;
      if (panel.kind === 'primary') {
        // The dashboard's own sub-tabs still belong to the dashboard, so they
        // ride above the content rather than in the panel header.
        body = (
          <>
            <TopTabs subRowOnly />
            {children}
          </>
        );
      } else if (panel.kind === 'pane') {
        body = pane.body;
      } else {
        body = (
          <RoutePanel url={panel.url ?? '/'} onUrlChange={(url) => onPanelUrlChanged(panel.id, url)} />
        );
      }
      // The wrapper is inert layout glue except for one job: when the
      // conversation router says "it's already right here", this is the panel
      // that blinks — the answer to "open this" being a place, not an action.
      return (
        <div className={styles.flashHost}>
          {body}
          {flashId === panel.id ? <div className={styles.flashRing} aria-hidden="true" /> : null}
        </div>
      );
    },
    [children, pane.body, onPanelUrlChanged, flashId],
  );

  /**
   * Every panel's header is its tab bar — except the reading room, which
   * brings its own three-way switcher instead (it isn't route-backed, so
   * section tabs would have nothing to point at).
   *
   * The primary panel's bar drives the real router; a route panel's just moves
   * that panel's own address, which is the same move its picker used to make.
   */
  const renderHeaderLeft = useCallback(
    (panel: PanelNode) => {
      if (panel.kind === 'pane') return pane.header;
      const isPrimary = panel.kind === 'primary';
      return (
        <TabBar
          url={isPrimary ? href : (panel.url ?? '/')}
          setId={panel.setId ?? (isPrimary ? 'life' : 'work')}
          openTabs={panel.tabs ?? []}
          onSetId={(setId) => onSetId(panel.id, setId)}
          onOpenTabs={(tabs) => onOpenTabs(panel.id, tabs)}
          onNavigate={(url) => navigatePanel(panel.id, url, isPrimary)}
        />
      );
    },
    [pane.header, href, onSetId, onOpenTabs, navigatePanel],
  );

  return (
    <div className={styles.workspace}>
      <PanelTree
        node={layout}
        onSplit={onSplit}
        onClose={onClose}
        onPick={onPick}
        onResize={onResize}
        onDragChange={setDragging}
        renderContent={renderContent}
        renderHeaderLeft={renderHeaderLeft}
        isClosable={(p) => p.kind !== 'primary'}
      />
      {/* While a boundary is being dragged this sits over everything, so the
          pointer isn't swallowed by a terminal iframe or a page that captures
          mouse moves — the drag keeps working across panel borders. */}
      {dragging ? <div className={styles.dragOverlay} /> : null}
    </div>
  );
}
