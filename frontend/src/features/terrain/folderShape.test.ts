import { describe, expect, it } from 'vitest';
import { FOLDER_TAB_MIN_PX, folderBox, folderOutline, roundedPolygonPoints } from './terrainCanvas';

/**
 * folderShape.test.ts — the outline behind the map's folder nodes
 * (folderOutline in terrainCanvas.ts): a folder far out is a plain rounded
 * rectangle, and up close the same rectangle with a tab notched into its top
 * edge.
 *
 * The one thing worth pinning is that the notch is cut DOWN into the box
 * rather than added on top of it, so the folder's footprint is identical
 * either side of the level-of-detail switch and zooming can't make a node
 * jump. Everything else here is geometry that would be obvious on screen the
 * moment it broke; that isn't.
 *
 * roundedPolygonPoints is tested here too: it's what turns that outline into
 * the polyline the canvas walks by length to give each file type its share of
 * a folder's border, so a folder with a bulge or a NaN in it would take the
 * whole paint loop down rather than just looking wrong.
 */

/** The smallest box containing every point of an outline. */
function bounds(points: readonly [number, number][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

const RADIUS = 8;
/** A zoom that puts the body well over the tab threshold, and one well under. */
const CLOSE = (FOLDER_TAB_MIN_PX / folderBox(RADIUS).height) * 4;
const FAR = (FOLDER_TAB_MIN_PX / folderBox(RADIUS).height) / 4;

describe('folderOutline', () => {
  it('is a plain rectangle when the folder is small on screen', () => {
    expect(folderOutline(0, 0, RADIUS, FAR)).toHaveLength(4);
  });

  it('grows a tab once the folder is big enough on screen to show one', () => {
    expect(folderOutline(0, 0, RADIUS, CLOSE)).toHaveLength(6);
  });

  it('switches exactly at the threshold, not around it', () => {
    const { height } = folderBox(RADIUS);
    expect(folderOutline(0, 0, RADIUS, FOLDER_TAB_MIN_PX / height)).toHaveLength(6);
    expect(folderOutline(0, 0, RADIUS, (FOLDER_TAB_MIN_PX - 0.01) / height)).toHaveLength(4);
  });

  it('keeps the same footprint either side of the switch, so nothing jumps', () => {
    expect(bounds(folderOutline(0, 0, RADIUS, CLOSE))).toEqual(
      bounds(folderOutline(0, 0, RADIUS, FAR)),
    );
  });

  it('fills the box the radius asks for, centred on the node', () => {
    const { width, height } = folderBox(RADIUS);
    const box = bounds(folderOutline(30, 12, RADIUS, CLOSE));
    expect(box.right - box.left).toBeCloseTo(width);
    expect(box.bottom - box.top).toBeCloseTo(height);
    expect((box.left + box.right) / 2).toBeCloseTo(30);
    expect((box.top + box.bottom) / 2).toBeCloseTo(12);
  });

  it('notches the tab out of the LEFT of the top edge', () => {
    const points = folderOutline(0, 0, RADIUS, CLOSE);
    const box = bounds(points);
    const onTop = points.filter((p) => p[1] === box.top);
    // Two corners at the very top — the tab's — and both on the left half.
    expect(onTop).toHaveLength(2);
    for (const [x] of onTop) expect(x).toBeLessThan((box.left + box.right) / 2);
    // The body's own top sits lower, which is what makes it a notch.
    const bodyTop = Math.min(...points.filter((p) => p[1] !== box.top).map((p) => p[1]));
    expect(bodyTop).toBeGreaterThan(box.top);
    expect(bodyTop).toBeLessThan(box.bottom);
  });

  it('rounds the corners without ever bulging outside the box', () => {
    const square = folderOutline(0, 0, RADIUS, FAR);
    const box = bounds(square);
    const rounded = roundedPolygonPoints(square, folderBox(RADIUS).height * 0.2);
    const roundedBox = bounds(rounded);
    expect(roundedBox.left).toBeGreaterThanOrEqual(box.left - 1e-9);
    expect(roundedBox.right).toBeLessThanOrEqual(box.right + 1e-9);
    expect(roundedBox.top).toBeGreaterThanOrEqual(box.top - 1e-9);
    expect(roundedBox.bottom).toBeLessThanOrEqual(box.bottom + 1e-9);
  });

  it('samples every corner, so the outline can be walked by length', () => {
    const tabbed = folderOutline(0, 0, RADIUS, CLOSE);
    const rounded = roundedPolygonPoints(tabbed, folderBox(RADIUS).height * 0.2);
    expect(rounded.length).toBeGreaterThan(tabbed.length);
    for (const [x, y] of rounded) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('rounds the tab\'s inward corner too, not just the outward ones', () => {
    // The shoulder where the tab steps down is the one CONCAVE corner on the
    // shape; an arc that only handled convex corners would leave it a spike.
    const tabbed = folderOutline(0, 0, RADIUS, CLOSE);
    const radius = folderBox(RADIUS).height * 0.2;
    const rounded = roundedPolygonPoints(tabbed, radius);
    // No output point sits exactly on the original shoulder vertex.
    const shoulder = tabbed[2];
    for (const [x, y] of rounded) {
      expect(Math.hypot(x - shoulder[0], y - shoulder[1])).toBeGreaterThan(1e-6);
    }
  });

  it('survives a degenerate outline rather than emitting NaN', () => {
    const doubled: [number, number][] = [
      [0, 0],
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    for (const [x, y] of roundedPolygonPoints(doubled, 3)) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('is wider than it is tall, the way a folder is', () => {
    const { width, height } = folderBox(RADIUS);
    expect(width).toBeGreaterThan(height);
  });
});
