/**
 * layoutMemory — the Terrain map's memory of where everything was: round-trips,
 * what survives a reload, and tolerance for a storage that isn't there.
 */
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { forgetLayout, forgetPins, recallLayout, rememberLayout } from './layoutMemory';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** A reload: the module's in-memory copy is gone, the storage under it isn't. */
async function reload(): Promise<typeof import('./layoutMemory')> {
  vi.resetModules();
  return import('./layoutMemory');
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
  forgetLayout();
});

// Hand the real globals back, so a stubbed-away localStorage can't reach
// anything that runs after this file.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('layoutMemory', () => {
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

  // The reason this module keeps a mirror at all: a reload doesn't run any
  // cleanup, so the map has to be waiting on disk when the next page starts.
  it('survives a reload — positions, pins and the camera all come back', async () => {
    rememberLayout(
      [
        { id: 'a', x: 12.34, y: -7.89, pinned: true },
        { id: 'b', x: 5, y: 6 },
      ],
      { x: -20, y: 40, k: 0.75 },
    );
    const fresh = await reload();
    const recalled = fresh.recallLayout();
    // Coordinates are stored rounded to a tenth — finer than a dot is wide.
    expect(recalled?.nodes.get('a')).toEqual({ x: 12.3, y: -7.9, pinned: true });
    expect(recalled?.nodes.get('b')).toEqual({ x: 5, y: 6, pinned: false });
    expect(recalled?.camera).toEqual({ x: -20, y: 40, k: 0.75 });
  });

  it('forgetting clears the stored copy too, so a reload lays out fresh', async () => {
    rememberLayout([{ id: 'a', x: 1, y: 2 }], null);
    forgetLayout();
    const fresh = await reload();
    expect(fresh.recallLayout()).toBeNull();
  });

  it('releasing pins sticks across a reload', async () => {
    rememberLayout([{ id: 'a', x: 1, y: 2, pinned: true }], null);
    forgetPins();
    const fresh = await reload();
    expect(fresh.recallLayout()?.nodes.get('a')).toEqual({ x: 1, y: 2, pinned: false });
  });

  it('reads nothing out of a corrupt store rather than scattering the map', async () => {
    localStorage.setItem('terrain.layout.v2', '{not json');
    const fresh = await reload();
    expect(fresh.recallLayout()).toBeNull();
  });

  it('works with no storage at all — the map just lays out fresh next time', async () => {
    vi.stubGlobal('localStorage', undefined);
    const fresh = await reload();
    expect(() => fresh.rememberLayout([{ id: 'a', x: 1, y: 2 }], null)).not.toThrow();
    expect(fresh.recallLayout()?.nodes.get('a')).toEqual({ x: 1, y: 2, pinned: false });
  });
});
