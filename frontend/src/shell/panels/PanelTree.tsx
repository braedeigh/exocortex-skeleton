import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { PanelFrame } from './PanelFrame';
import { isWhollyHidden, type LayoutNode, type PanelNode } from './layoutTree';
import styles from './PanelTree.module.css';

/**
 * PanelTree.tsx — draws a layout tree, and lets you drag its boundaries.
 *
 * Walks the tree from layoutTree.ts and renders it: a split becomes a flex row
 * or column with a draggable boundary between each pair of children, and a
 * panel becomes a framed tile. It recurses, so nesting comes free — "left half
 * stacked in two, right half one tall tile" needs no special case.
 *
 * Sizes are percentages and go on `flex-basis`, with `flex-grow: 0`, so the
 * boxes hold the proportions the tree says rather than negotiating their own.
 *
 * HOW A DRAG WORKS. A boundary reports how far it moved as a percentage of its
 * own container, and reports it as a DELTA since the last pointer event rather
 * than as an absolute position. Deltas are what let layoutTree clamp each move
 * against the minimum panel size without the pointer and the boundary drifting
 * apart: throw the pointer past the end and the boundary stops, and the
 * boundary picks the pointer back up on the way in.
 *
 * Automatic full screen hides panels without touching the tree: a hidden child
 * draws as nothing and its siblings grow equally into the space (see SplitBox).
 *
 * The tree is a controlled value from Workspace.tsx — this component holds no
 * layout state at all, which is what keeps the arrangement in one place and
 * makes it saveable.
 *
 * Touches: layoutTree.ts (the shape), PanelFrame.tsx (each tile),
 * Workspace.tsx (owns the tree and supplies the tile contents).
 */

export interface PanelTreeProps {
  node: LayoutNode;
  onSplit: (panelId: string, dir: 'row' | 'col') => void;
  onClose: (panelId: string) => void;
  onPick: (panelId: string, url: string) => void;
  /** The boundary after child `boundary`, before child `next`; delta is percent
   *  of the split. */
  onResize: (splitId: string, boundary: number, deltaPct: number, next: number) => void;
  onDragChange: (dragging: boolean) => void;
  renderContent: (panel: PanelNode) => ReactNode;
  /** What fills the left of a panel's header row — its tab bar. */
  renderHeaderLeft?: (panel: PanelNode) => ReactNode | undefined;
  /** Whether a panel can be closed right now (layoutTree.canClosePanel). */
  isClosable: (panel: PanelNode) => boolean;
  /** Panels to draw as nothing while staying mounted (layoutTree.fullScreenPlan). */
  hidden: ReadonlySet<string>;
  /** The on/off switch for full screen, on the one panel that has it. */
  fullScreenFor?: (panel: PanelNode) => { on: boolean; onToggle: () => void } | undefined;
}

export function PanelTree(props: PanelTreeProps) {
  const { node } = props;
  if (node.type === 'panel') return <PanelTile panel={node} {...props} />;
  return <SplitBox split={node} {...props} />;
}

function PanelTile({ panel, ...p }: PanelTreeProps & { panel: PanelNode }) {
  return (
    <PanelFrame
      onSplitRight={() => p.onSplit(panel.id, 'row')}
      onSplitDown={() => p.onSplit(panel.id, 'col')}
      onClose={p.isClosable(panel) ? () => p.onClose(panel.id) : undefined}
      headerLeft={p.renderHeaderLeft?.(panel)}
      fullScreen={p.fullScreenFor?.(panel)}
    >
      {p.renderContent(panel)}
    </PanelFrame>
  );
}

function SplitBox({ split, ...p }: PanelTreeProps & { split: Extract<LayoutNode, { type: 'split' }> }) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Which boundary is being dragged, and where the pointer was last time we
  // heard from it. Refs, not state: a drag updates on every pointer move and
  // must not re-render this box on its own account.
  const drag = useRef<{ boundary: number; next: number; last: number } | null>(null);
  const { onResize, onDragChange, hidden } = p;

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      const box = boxRef.current;
      if (!d || !box) return;
      const rect = box.getBoundingClientRect();
      const span = split.dir === 'row' ? rect.width : rect.height;
      if (span === 0) return;
      const pos = split.dir === 'row' ? e.clientX : e.clientY;
      const deltaPct = ((pos - d.last) / span) * 100;
      d.last = pos;
      if (deltaPct !== 0) onResize(split.id, d.boundary, deltaPct, d.next);
    },
    [split.dir, split.id, onResize],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
    onDragChange(false);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove, onDragChange]);

  // Listeners live on the window, not the boundary, so a fast drag that
  // outruns the 6px handle keeps resizing instead of dropping the gesture.
  const startDrag = useCallback(
    (boundary: number, next: number, e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = { boundary, next, last: split.dir === 'row' ? e.clientX : e.clientY };
      onDragChange(true);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endDrag);
    },
    [split.dir, onPointerMove, endDrag, onDragChange],
  );

  // A tile closed mid-drag (or the tree replaced underneath) would otherwise
  // leave the window listeners attached forever.
  useEffect(() => endDrag, [endDrag]);

  // Hide a child that's wholly out of sight, and let the rest grow into its
  // space. Hiding rather than unmounting keeps its page, its scroll and its
  // requests alive, so it comes back exactly as it was. A boundary shows only
  // between two children still in sight, and drags those two.
  const gone = split.children.map((child) => isWhollyHidden(child, hidden));
  const anyGone = gone.includes(true);

  return (
    <div ref={boxRef} className={split.dir === 'row' ? styles.row : styles.col}>
      {split.children.map((child, i) => {
        const next = gone.findIndex((isGone, j) => j > i && !isGone);
        return (
          <Fragmentish key={child.id}>
            <div
              className={styles.slot}
              style={{
                flexBasis: `${split.sizes[i]}%`,
                flexGrow: anyGone ? 1 : undefined,
                display: gone[i] ? 'none' : undefined,
              }}
            >
              <PanelTree {...p} node={child} />
            </div>
            {!gone[i] && next !== -1 ? (
              <div
                className={split.dir === 'row' ? styles.dividerV : styles.dividerH}
                role="separator"
                aria-orientation={split.dir === 'row' ? 'vertical' : 'horizontal'}
                onPointerDown={(e) => startDrag(i, next, e)}
              />
            ) : null}
          </Fragmentish>
        );
      })}
    </div>
  );
}

/** A keyed pair of siblings. Inlined rather than imported so the key lands on
 *  one element covering both the slot and the boundary after it. */
function Fragmentish({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
