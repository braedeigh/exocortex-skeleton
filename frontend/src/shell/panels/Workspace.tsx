import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { TopTabs } from '../TopTabs';
import { PanelTree } from './PanelTree';
import { RoutePanel } from './RoutePanel';
import { TabBar } from './TabBar';
import { usePaneStack } from './PaneStack';
import {
  closePanel,
  listPanels,
  resizeSplit,
  setPanelSet,
  setPanelUrl,
  splitPanel,
  type PanelNode,
} from './layoutTree';
import { newId, newRoutePanel, useLayout } from './panelStore';
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

  const onResize = useCallback(
    (splitId: string, boundary: number, deltaPct: number) =>
      setLayout((cur) => resizeSplit(cur, splitId, boundary, deltaPct)),
    [setLayout],
  );

  const renderContent = useCallback(
    (panel: PanelNode): ReactNode => {
      if (panel.kind === 'primary') {
        // The dashboard's own sub-tabs still belong to the dashboard, so they
        // ride above the content rather than in the panel header.
        return (
          <>
            <TopTabs subRowOnly />
            {children}
          </>
        );
      }
      if (panel.kind === 'pane') return pane.body;
      return <RoutePanel url={panel.url ?? '/'} onUrlChange={(url) => onPick(panel.id, url)} />;
    },
    [children, pane.body, onPick],
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
          onSetId={(setId) => onSetId(panel.id, setId)}
          onNavigate={(url) => {
            if (isPrimary) void navigate({ to: url });
            else onPick(panel.id, url);
          }}
        />
      );
    },
    [pane.header, href, navigate, onPick, onSetId],
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
