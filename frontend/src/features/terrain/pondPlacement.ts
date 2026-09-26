/**
 * pondPlacement.ts — where the pond landmark's pieces go on screen, worked out
 * from where the pond tile is.
 *
 * The canvas paints the pond tile (terrainCanvas.ts) and reports its square in
 * screen pixels: a centre and a half-side (PondAnchor). PondLandmark.tsx hangs
 * three things off that square, and this file says where each one lands:
 *
 *   THE NAME   at rest, just above the square's top edge — a map caption over
 *              its symbol — kept on screen when the square's top is not.
 *   THE PANE   once reached, a panel that opens ABOVE the square rather than
 *              on top of it, so the tile and the water lit under it stay in
 *              view. No room above → below. No room either side → over it,
 *              kept inside the viewport.
 *   THE BRIDGE an invisible strip joining the square to the open pane, so a
 *              mouse travelling from one to the other never leaves the
 *              landmark (which would close the pane on the way).
 *
 * Pure arithmetic, no DOM — tested in pondPlacement.test.ts.
 *
 * Prompt that produced it: "the label doesn't float above the little popup
 * thing, and the popup thing isn't drawn quite right".
 */
import type { PondAnchor } from './terrainCanvas';

/** Space kept between the landmark and the viewport's edges. */
export const EDGE_MARGIN = 12;
/** Space between the square and an open pane. */
export const PANE_GAP = 10;
/** Space between the square's top edge and the bottom of its name. */
export const LABEL_GAP = 6;
/** Roughly how tall the resting name is — only used to keep it on screen. */
const LABEL_HEIGHT = 20;
/** Half the width the resting name usually takes — "POND" is about 40px.
 * Only used to keep it on screen at the edges; reserving its full 200px
 * max-width pushed the name visibly off-centre from the tile near an edge. */
const LABEL_HALF_WIDTH = 24;

export interface Viewport {
  width: number;
  height: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PanePlacement = 'above' | 'below' | 'over';

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/**
 * How tall a pane can be in each placement — the room above the square, the
 * room below it, and the whole viewport. The resize grip is capped by these,
 * so dragging it never pushes the pane over the square it belongs to.
 */
export function paneRoom(anchor: PondAnchor, viewport: Viewport): Record<PanePlacement, number> {
  return {
    above: anchor.y - anchor.half - PANE_GAP - EDGE_MARGIN,
    below: viewport.height - EDGE_MARGIN - (anchor.y + anchor.half + PANE_GAP),
    over: viewport.height - EDGE_MARGIN * 2,
  };
}

/**
 * Place the open pane: above the square if it fits, else below, else over it.
 * Horizontally it centres on the square and slides inward at the edges.
 */
export function placePane(
  anchor: PondAnchor,
  size: { width: number; height: number },
  viewport: Viewport,
): Rect & { placement: PanePlacement } {
  const room = paneRoom(anchor, viewport);
  const left = clamp(
    anchor.x - size.width / 2,
    EDGE_MARGIN,
    viewport.width - EDGE_MARGIN - size.width,
  );
  const base = { left, width: size.width, height: size.height };
  if (size.height <= room.above) {
    return { ...base, placement: 'above', top: anchor.y - anchor.half - PANE_GAP - size.height };
  }
  if (size.height <= room.below) {
    return { ...base, placement: 'below', top: anchor.y + anchor.half + PANE_GAP };
  }
  return {
    ...base,
    placement: 'over',
    top: clamp(
      anchor.y - size.height / 2,
      EDGE_MARGIN,
      viewport.height - EDGE_MARGIN - size.height,
    ),
  };
}

/**
 * The hover bridge: the reach target's width, stretched vertically to meet the
 * pane. It covers the reach target itself too, because the pointer is sitting
 * there at the moment the pane opens.
 */
export function hoverBridge(anchor: PondAnchor, reachSide: number, pane: Rect): Rect {
  const reachTop = anchor.y - reachSide / 2;
  const reachBottom = anchor.y + reachSide / 2;
  const top = Math.min(reachTop, pane.top + pane.height);
  const bottom = Math.max(reachBottom, pane.top);
  return { left: anchor.x - reachSide / 2, top, width: reachSide, height: bottom - top };
}

/**
 * The resting name's spot: the bottom-centre of the name, just over the
 * square's top edge. The name is drawn with translate(-50%, -100%), so this
 * point is where its bottom-middle sits. Clamped so a square whose top has
 * scrolled off screen still shows its name at the top of the viewport.
 */
export function placeLabel(anchor: PondAnchor, viewport: Viewport): { x: number; y: number } {
  return {
    x: clamp(anchor.x, EDGE_MARGIN + LABEL_HALF_WIDTH, viewport.width - EDGE_MARGIN - LABEL_HALF_WIDTH),
    y: clamp(
      anchor.y - anchor.half - LABEL_GAP,
      EDGE_MARGIN + LABEL_HEIGHT,
      viewport.height - EDGE_MARGIN,
    ),
  };
}
