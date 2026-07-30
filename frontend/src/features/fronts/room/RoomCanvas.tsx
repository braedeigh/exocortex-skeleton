/**
 * RoomCanvas.tsx — the furnishable surface. Panels are absolutely positioned
 * boxes on a 12-column grid that can be dragged by their header and resized
 * from their bottom-right corner; where they end up is remembered per front.
 *
 * Hand-rolled on pointer events rather than pulled from a windowing library:
 * the whole interaction is a pointerdown that captures, a pointermove that
 * converts pixel delta to grid cells, and a pointerup that commits. Pointer
 * capture is what makes it survive the cursor leaving the panel mid-drag.
 *
 * Below CANVAS_MIN_WIDTH the canvas is abandoned entirely for a vertical stack
 * in reading order — a free canvas needs a pointer and room to drag, and a
 * phone has neither. Nothing here is reachable by touch by design.
 *
 * Prompt that produced it: "i want the to-do list pinned up on the corner,
 * then other stuff in the room ... little windows that i can resize and drag
 * around."
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CANVAS_MIN_WIDTH,
  ROOM_GAP,
  ROW_HEIGHT,
  boxToPixels,
  clampBox,
  pixelsToCells,
  rowsNeeded,
  stackOrder,
  type PanelBox,
  type RoomLayout,
} from './roomLayout';
import styles from './RoomCanvas.module.css';

export interface RoomPanelDef {
  key: string;
  title: string;
  /** Shown next to the title — a count, a status, whatever the panel knows. */
  badge?: ReactNode;
  render: () => ReactNode;
}

interface DragState {
  key: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  origin: PanelBox;
}

export function RoomCanvas({
  panels,
  layout,
  onLayoutChange,
  onLayoutCommit,
}: {
  panels: RoomPanelDef[];
  layout: RoomLayout;
  onLayoutChange: (next: RoomLayout) => void;
  onLayoutCommit: (next: RoomLayout) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const drag = useRef<DragState | null>(null);
  // The layout as the pointer handlers see it — refs, not state, so a move
  // event never reads a stale closure mid-drag.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(host);
    setWidth(host.clientWidth);
    return () => ro.disconnect();
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d || width <= 0) return;
      const { dx, dy } = pixelsToCells(e.clientX - d.startX, e.clientY - d.startY, width);
      const box = d.origin;
      const next =
        d.mode === 'move'
          ? clampBox({ ...box, x: box.x + dx, y: box.y + dy })
          : clampBox({ ...box, w: box.w + dx, h: box.h + dy });
      const current = layoutRef.current[d.key];
      if (current && current.x === next.x && current.y === next.y && current.w === next.w && current.h === next.h) {
        return; // moved less than a whole cell — nothing to redraw
      }
      onLayoutChange({ ...layoutRef.current, [d.key]: next });
    },
    [width, onLayoutChange],
  );

  const endDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    onLayoutCommit(layoutRef.current);
  }, [onPointerMove, onLayoutCommit]);

  useEffect(() => {
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, [endDrag, onPointerMove]);

  function startDrag(e: React.PointerEvent, key: string, mode: 'move' | 'resize') {
    const box = layoutRef.current[key];
    if (!box || e.button !== 0) return;
    e.preventDefault();
    drag.current = { key, mode, startX: e.clientX, startY: e.clientY, origin: box };
    window.addEventListener('pointermove', onPointerMove);
  }

  const stacked = width > 0 && width < CANVAS_MIN_WIDTH;
  const rows = rowsNeeded(layout);

  return (
    <div
      ref={hostRef}
      className={stacked ? styles.stack : styles.canvas}
      style={stacked ? undefined : { height: rows * (ROW_HEIGHT + ROOM_GAP) }}
    >
      {(stacked ? stackOrder(panels.map((p) => p.key), layout) : panels.map((p) => p.key)).map((key) => {
        const panel = panels.find((p) => p.key === key);
        const box = layout[key];
        if (!panel || !box) return null;
        const px = stacked || width <= 0 ? null : boxToPixels(box, width);

        return (
          <section
            key={key}
            className={styles.panel}
            style={
              px
                ? { position: 'absolute', left: px.left, top: px.top, width: px.width, height: px.height }
                : undefined
            }
          >
            <header
              className={styles.panelHead}
              onPointerDown={stacked ? undefined : (e) => startDrag(e, key, 'move')}
              data-draggable={stacked ? undefined : 'true'}
            >
              <h2 className={styles.panelTitle}>{panel.title}</h2>
              {panel.badge != null && <span className={styles.panelBadge}>{panel.badge}</span>}
            </header>

            <div className={styles.panelBody}>{panel.render()}</div>

            {!stacked && (
              <span
                className={styles.resize}
                onPointerDown={(e) => startDrag(e, key, 'resize')}
                aria-hidden="true"
              />
            )}
          </section>
        );
      })}
    </div>
  );
}
