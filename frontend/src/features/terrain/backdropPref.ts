import { useSyncExternalStore } from 'react';

/**
 * backdropPref.ts — the one switch that says whether the terrain map is
 * allowed to sit and breathe behind the Observatory.
 *
 * The map is wallpaper for reading against (TerrainBackdrop.tsx), and
 * sometimes wallpaper is the last thing you want moving behind your words. The
 * ▦ button in the Observatory's composer toolbar flips this; the backdrop
 * unmounts entirely when it's off, so the canvas, the breath interval and the
 * terrain polling all stop rather than just going invisible.
 *
 * It's ONE setting for every room and every window, not one per session:
 * stored in localStorage, so it survives a reload and a fresh tab, and
 * broadcast two ways so other windows follow within the same gesture —
 * `listeners` for anything mounted in this document (the docked pane and the
 * page both, in the desktop split), and the browser's `storage` event for
 * other tabs and windows of the same origin.
 *
 * Prompt that produced it: "make an option in the buttons on the observatory
 * chat sessions to be able to toggle off the background animation of the
 * terrain. it will remain off in all windows until the button is pressed
 * again."
 */

const KEY = 'observatory-backdrop';

/** On unless she has explicitly turned it off — a missing key is a new
 * browser, not a preference. */
function fromStorage(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    // localStorage unavailable (private mode, blocked cookies) — the map shows
    // and the toggle simply won't outlive the tab.
    return true;
  }
}

const listeners = new Set<() => void>();
// Cached so getSnapshot below is cheap and stable — useSyncExternalStore calls
// it on every render and would tear if it returned a fresh read each time.
let current = typeof window === 'undefined' ? true : fromStorage();

function announce(): void {
  for (const fn of listeners) fn();
}

// Another window changed it. `storage` fires only in OTHER documents, so this
// never double-handles our own write.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== KEY) return;
    const next = fromStorage();
    if (next === current) return;
    current = next;
    announce();
  });
}

export function terrainBackdropOn(): boolean {
  return current;
}

export function setTerrainBackdropOn(on: boolean): void {
  if (on === current) return;
  current = on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Can't persist — the toggle still works for this window.
  }
  announce();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The live value, re-rendering the caller whenever it changes anywhere. */
export function useTerrainBackdropOn(): boolean {
  return useSyncExternalStore(subscribe, terrainBackdropOn, () => true);
}
