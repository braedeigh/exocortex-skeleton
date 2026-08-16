import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { PanelTree } from './PanelTree';
import { RoutePanel } from './RoutePanel';
import { usePaneStack } from './PaneStack';
import { closePanel, listPanels, resizeSplit, setPanelUrl, splitPanel, type PanelNode } from './layoutTree';
import { newId, newRoutePanel, useLayout } from './panelStore';
import styles from './Workspace.module.css';

/**
 * Workspace.tsx — the tiling desktop: however many panels you want, arranged
 * however you like, resizable, and remembered.
 *
 * This is what replaced the fixed left-box / divider / right-box arrangement.
 * It opens on exactly that arrangement — the reading room beside the routed
 * content — so nothing looks different until you split something. From there,
 * every tile's header has "split beside", "split below", and "close", and the
 * boundaries drag.
 *
 * THE THREE KINDS OF TILE, and why there are three rather than one:
 *
 * - The PRIMARY tile is the app as it always was: the tab strip and whatever
 *   page the browser's address bar says. There is exactly one, and it can't be
 *   closed, because it's the tile the URL, the back button, and every existing
 *   link drive. Keeping it intact is why nothing else in the app had to change.
 * - The READING ROOM tile is the old left box — Observatory / session /
 *   Terminal — which isn't a page and never was (PaneStack.tsx).
 * - A ROUTE tile is any page in the app running on its own private address bar
 *   (RoutePanel.tsx). This is the one that makes the terrain map and a code
 *   file possible side by side.
 *
 * The layout itself is one value living here and saved per browser window
 * (panelStore.ts), so a second window on another monitor can be arranged
 * completely differently without disturbing this one.
 *
 * Touches: layoutTree.ts (the operations), PanelTree.tsx (draws it),
 * panelStore.ts (remembers it), SplitLayout.tsx (mounts it on authed desktop).
 *
 * Prompt that produced it: "being able to create multiple windows within the
 * browser... auto displays 2 in the split screen maybe, but I want to be able
 * to resize the panels and create multiple on one screen or just one".
 */
export function Workspace({ chrome, children }: { chrome: ReactNode; children: ReactNode }) {
  const [layout, setLayout] = useLayout();
  const [dragging, setDragging] = useState(false);

  // The reading room is a tile you can close. Its hooks still run either way
  // (they have to — hooks can't be conditional), but everything they register
  // is gated on the tile actually being in the layout, so with it closed the
  // features that push work at it fall back to navigating instead.
  const paneOpen = useMemo(() => listPanels(layout).some((p) => p.kind === 'pane'), [layout]);
  const pane = usePaneStack(paneOpen);

  const onSplit = useCallback(
    (panelId: string, dir: 'row' | 'col') => {
      setLayout((cur) => splitPanel(cur, panelId, dir, newRoutePanel(), newId('split')));
    },
    [setLayout],
  );

  const onClose = useCallback((panelId: string) => setLayout((cur) => closePanel(cur, panelId)), [setLayout]);

  const onPick = useCallback(
    (panelId: string, url: string) => setLayout((cur) => setPanelUrl(cur, panelId, url)),
    [setLayout],
  );

  const onResize = useCallback(
    (splitId: string, boundary: number, deltaPct: number) =>
      setLayout((cur) => resizeSplit(cur, splitId, boundary, deltaPct)),
    [setLayout],
  );

  const renderContent = useCallback(
    (panel: PanelNode): ReactNode => {
      if (panel.kind === 'primary') return children;
      if (panel.kind === 'pane') return pane.body;
      return <RoutePanel url={panel.url ?? '/'} onUrlChange={(url) => onPick(panel.id, url)} />;
    },
    [children, pane.body, onPick],
  );

  // Two tiles bring their own header content instead of taking a plain name.
  // The reading room supplies its Observatory / Session / Terminal switcher,
  // and the primary tile supplies the app's tab strip — which is why the
  // dashboard doesn't end up with a tile header stacked on top of the tabs
  // saying much the same thing. Both then share the row with the split and
  // close controls on the right.
  const renderHeaderLeft = useCallback(
    (panel: PanelNode) => {
      if (panel.kind === 'pane') return pane.header;
      if (panel.kind === 'primary') return <div className={styles.chrome}>{chrome}</div>;
      return undefined;
    },
    [pane.header, chrome],
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
        overlayActions={(p) => p.kind === 'primary'}
      />
      {/* While a boundary is being dragged this sits over everything, so the
          pointer isn't swallowed by a terminal iframe or a page that captures
          mouse moves — the drag keeps working across tile borders. */}
      {dragging ? <div className={styles.dragOverlay} /> : null}
    </div>
  );
}
