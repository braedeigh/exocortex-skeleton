import { describe, expect, it } from 'vitest';
import {
  EDGE_MARGIN,
  LABEL_GAP,
  PANE_GAP,
  hoverBridge,
  paneRoom,
  placeLabel,
  placePane,
} from './pondPlacement';

const viewport = { width: 1200, height: 800 };
const size = { width: 460, height: 360 };

describe('placePane', () => {
  it('opens above the square when there is room, its bottom a gap over the top edge', () => {
    const anchor = { x: 600, y: 600, half: 60 };
    const pane = placePane(anchor, size, viewport);
    expect(pane.placement).toBe('above');
    expect(pane.top + pane.height).toBe(anchor.y - anchor.half - PANE_GAP);
  });

  it('opens below the square when the room above is too short', () => {
    const anchor = { x: 600, y: 150, half: 60 };
    const pane = placePane(anchor, size, viewport);
    expect(pane.placement).toBe('below');
    expect(pane.top).toBe(anchor.y + anchor.half + PANE_GAP);
  });

  it('falls back to over the square, inside the viewport, when neither side fits', () => {
    const anchor = { x: 600, y: 400, half: 300 };
    const pane = placePane(anchor, size, viewport);
    expect(pane.placement).toBe('over');
    expect(pane.top).toBeGreaterThanOrEqual(EDGE_MARGIN);
    expect(pane.top + pane.height).toBeLessThanOrEqual(viewport.height - EDGE_MARGIN);
  });

  it('centres on the square and slides inward at the viewport edge', () => {
    expect(placePane({ x: 600, y: 600, half: 60 }, size, viewport).left).toBe(600 - 230);
    expect(placePane({ x: 20, y: 600, half: 60 }, size, viewport).left).toBe(EDGE_MARGIN);
  });
});

describe('paneRoom', () => {
  it('never lets an above-pane that fits the room reach the square', () => {
    const anchor = { x: 600, y: 600, half: 60 };
    const room = paneRoom(anchor, viewport);
    const pane = placePane(anchor, { width: 460, height: room.above }, viewport);
    expect(pane.placement).toBe('above');
    expect(pane.top).toBe(EDGE_MARGIN);
  });
});

describe('hoverBridge', () => {
  it('spans from the pane bottom down through the reach target', () => {
    const anchor = { x: 600, y: 600, half: 60 };
    const pane = placePane(anchor, size, viewport);
    const bridge = hoverBridge(anchor, 120, pane);
    expect(bridge.top).toBe(pane.top + pane.height);
    expect(bridge.top + bridge.height).toBe(anchor.y + 60);
  });

  it('spans from the reach target down to a pane that opened below', () => {
    const anchor = { x: 600, y: 150, half: 60 };
    const pane = placePane(anchor, size, viewport);
    const bridge = hoverBridge(anchor, 120, pane);
    expect(bridge.top).toBe(anchor.y - 60);
    expect(bridge.top + bridge.height).toBe(pane.top);
  });
});

describe('placeLabel', () => {
  it('sits just over the square top edge', () => {
    expect(placeLabel({ x: 600, y: 400, half: 50 }, viewport)).toEqual({
      x: 600,
      y: 400 - 50 - LABEL_GAP,
    });
  });

  it('stays on screen when the square top has scrolled off', () => {
    expect(placeLabel({ x: 600, y: 100, half: 400 }, viewport).y).toBeGreaterThan(EDGE_MARGIN);
  });
});
