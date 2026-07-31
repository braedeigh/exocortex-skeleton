/**
 * agentHoverPlacement.ts — where the agent hovercard goes.
 *
 * Pure geometry, in its own file because the card can't discover any of this by
 * measuring itself: it's positioned in the same breath it's created, before the
 * browser has laid it out. So its size is a constant here and the placement is
 * arithmetic — which also makes it testable (AgentHoverCard.test.ts).
 *
 * Used by AgentHoverCard.tsx (the card) and mirrored by its CSS module, which
 * is the one coupling to watch: CARD_WIDTH / CARD_MAX_HEIGHT below must match
 * the `width` / `max-height` in AgentHoverCard.module.css, or the card will be
 * clamped against a size it isn't.
 */

/** Must match `.card { width }` in AgentHoverCard.module.css. */
export const CARD_WIDTH = 320;
/** Must match `.card { max-height }` there. The card is usually SHORTER than
 * this — it only draws the parts it has data for — so this is a worst case,
 * which is the right thing to clamp against: it keeps a full card on screen and
 * costs a short one a little extra margin nobody can see. */
export const CARD_MAX_HEIGHT = 340;
/** Gap between the orb's edge and the card: enough to clear the orb's ring and
 * its sonar pulse, so the card never covers the thing being pointed at. */
export const ORB_GAP = 16;
/** How close to the viewport edge the card may come. */
export const EDGE = 12;

export interface Anchor {
  /** The orb's CENTRE in client coordinates. */
  x: number;
  y: number;
  /** Its drawn radius on screen. */
  r: number;
}

/**
 * Beside the orb, on whichever side has room, vertically centred on it and
 * never off-screen.
 *
 * Right by default — it's the reading direction, and the map's chrome lives
 * along the bottom and left. It flips left only when the card would run off the
 * right edge AND the left side can actually hold it; with neither side big
 * enough (a narrow window) it gives up on clearing the orb and just stays on
 * screen, since a card half past the edge is worse than one slightly overlapped.
 */
export function hoverCardPlacement(
  anchor: Anchor,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const right = anchor.x + anchor.r + ORB_GAP;
  const left = anchor.x - anchor.r - ORB_GAP - CARD_WIDTH;
  const flip = right + CARD_WIDTH > viewport.width - EDGE && left >= EDGE;
  return {
    left: Math.max(EDGE, Math.min(flip ? left : right, viewport.width - CARD_WIDTH - EDGE)),
    top: Math.max(
      EDGE,
      Math.min(anchor.y - CARD_MAX_HEIGHT / 2, viewport.height - CARD_MAX_HEIGHT - EDGE),
    ),
  };
}
