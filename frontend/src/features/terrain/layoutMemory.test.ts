import { describe, expect, it, beforeEach } from 'vitest';
import { forgetLayout, forgetPins, recallLayout, rememberLayout } from './layoutMemory';

describe('layoutMemory', () => {
  beforeEach(() => forgetLayout());

  it('has nothing to recall before anything is remembered', () => {
    expect(recallLayout()).toBeNull();
  });

  it('hands back the positions and the camera it was given', () => {
    rememberLayout([{ id: 'a', x: 10, y: -4, pinned: true }], { x: 3, y: 5, k: 0.8 });
    const recalled = recallLayout();
    expect(recalled?.nodes.get('a')).toEqual({ x: 10, y: -4, pinned: true });
    expect(recalled?.camera).toEqual({ x: 3, y: 5, k: 0.8 });
  });

  it('skips a node the sim never placed, rather than remembering it at the origin', () => {
    rememberLayout([{ id: 'placed', x: 1, y: 2 }, { id: 'unplaced' }], null);
    const recalled = recallLayout();
    expect(recalled?.nodes.has('placed')).toBe(true);
    expect(recalled?.nodes.has('unplaced')).toBe(false);
  });

  it('defaults a node to unpinned — only a drag pins one', () => {
    rememberLayout([{ id: 'a', x: 1, y: 2 }], null);
    expect(recallLayout()?.nodes.get('a')?.pinned).toBe(false);
  });

  it('releasing pins keeps every resting position', () => {
    rememberLayout(
      [
        { id: 'a', x: 1, y: 2, pinned: true },
        { id: 'b', x: 3, y: 4, pinned: false },
      ],
      { x: 0, y: 0, k: 1 },
    );
    forgetPins();
    const recalled = recallLayout();
    expect(recalled?.nodes.get('a')).toEqual({ x: 1, y: 2, pinned: false });
    expect(recalled?.nodes.get('b')).toEqual({ x: 3, y: 4, pinned: false });
  });

  it('a later remember replaces the earlier one wholesale', () => {
    rememberLayout([{ id: 'a', x: 1, y: 1 }], null);
    rememberLayout([{ id: 'b', x: 2, y: 2 }], null);
    const recalled = recallLayout();
    expect(recalled?.nodes.has('a')).toBe(false);
    expect(recalled?.nodes.get('b')).toEqual({ x: 2, y: 2, pinned: false });
  });
});
