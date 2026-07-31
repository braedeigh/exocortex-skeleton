import { describe, expect, it } from 'vitest';
import {
  CARD_MAX_HEIGHT,
  CARD_WIDTH,
  EDGE,
  hoverCardPlacement,
} from './agentHoverPlacement';

/**
 * Where the agent hovercard lands (agentHoverPlacement.ts). The card is
 * positioned before it exists to be measured, so all of this is arithmetic —
 * and the two things worth pinning are that it never covers the orb she's
 * pointing at, and that it never leaves the screen (a card half past the right
 * edge is exactly what a naive "just put it to the right" produces on a map
 * this wide).
 */

const VIEWPORT = { width: 1400, height: 900 };

describe('hoverCardPlacement', () => {
  it('sits to the right of the orb, clear of it, when there is room', () => {
    const { left } = hoverCardPlacement({ x: 400, y: 450, r: 10 }, VIEWPORT);
    expect(left).toBeGreaterThan(400 + 10); // past the orb's own edge
    expect(left + CARD_WIDTH).toBeLessThanOrEqual(VIEWPORT.width - EDGE);
  });

  it('flips to the left rather than run off the right edge', () => {
    const { left } = hoverCardPlacement({ x: 1340, y: 450, r: 10 }, VIEWPORT);
    expect(left + CARD_WIDTH).toBeLessThanOrEqual(1340 - 10); // wholly left of the orb
    expect(left).toBeGreaterThanOrEqual(EDGE);
  });

  it('stays on screen even when neither side has room', () => {
    const narrow = { width: 500, height: 900 };
    const { left } = hoverCardPlacement({ x: 250, y: 450, r: 10 }, narrow);
    expect(left).toBeGreaterThanOrEqual(EDGE);
    expect(left + CARD_WIDTH).toBeLessThanOrEqual(narrow.width - EDGE);
  });

  it('centres vertically on the orb, clamped to the viewport', () => {
    const middle = hoverCardPlacement({ x: 400, y: 450, r: 10 }, VIEWPORT);
    expect(middle.top).toBe(450 - CARD_MAX_HEIGHT / 2);

    // An orb near the top or the bottom would otherwise push the card off.
    expect(hoverCardPlacement({ x: 400, y: 20, r: 10 }, VIEWPORT).top).toBe(EDGE);
    const low = hoverCardPlacement({ x: 400, y: 880, r: 10 }, VIEWPORT);
    expect(low.top + CARD_MAX_HEIGHT).toBeLessThanOrEqual(VIEWPORT.height - EDGE);
  });

  it('clears a big orb by more than a small one', () => {
    const small = hoverCardPlacement({ x: 400, y: 450, r: 6 }, VIEWPORT);
    const big = hoverCardPlacement({ x: 400, y: 450, r: 40 }, VIEWPORT);
    expect(big.left).toBeGreaterThan(small.left);
  });
});
