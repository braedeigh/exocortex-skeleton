import { useSyncExternalStore } from 'react';

/**
 * codeHeatPref.ts — the one switch that says whether a file's lines are
 * painted red by when they were last edited (FileCodeBody's "edits" toggle,
 * the colour from lineEditHeat.ts).
 *
 * It's ONE setting across every file and every frame — the pane on the map,
 * the /code page, the pond's file panel — not one per file: once she turns
 * the red on, every file she opens after that is lit until she turns it off.
 * Stored in localStorage so it survives a reload, and broadcast two ways so
 * every window follows within the gesture — `listeners` for anything mounted
 * in this document, the browser's `storage` event for other tabs of the same
 * origin. Same shape as backdropPref.ts, which is the pattern for "a toggle
 * that stays" — an external store hook, React's name for a value kept outside
 * any component that components can subscribe to.
 *
 * Prompt that produced it: "show when the most recent code was edited by a
 * toggleable red color like on the terrain map".
 */

const KEY = 'terrain-code-heat';

/** Off unless she has explicitly turned it on — a file is plain text until
 * she asks for the heat. */
function fromStorage(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    // localStorage unavailable (private mode, blocked cookies) — the toggle
    // still works, it just won't outlive the tab.
    return false;
  }
}

const listeners = new Set<() => void>();
// Cached so getSnapshot below is cheap and stable — useSyncExternalStore
// calls it on every render and would tear if it re-read storage each time.
let current = typeof window === 'undefined' ? false : fromStorage();

function announce(): void {
  for (const fn of listeners) fn();
}

// Another window changed it. `storage` fires only in OTHER documents, so
// this never double-handles our own write.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== KEY) return;
    const next = fromStorage();
    if (next === current) return;
    current = next;
    announce();
  });
}

export function codeHeatOn(): boolean {
  return current;
}

export function setCodeHeatOn(on: boolean): void {
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

/** The live value, re-rendering the caller whenever it changes anywhere.
 * This is the external store hook itself (React's useSyncExternalStore),
 * reading `current` and listening through `subscribe`; off when rendered on
 * a server. */
export function useCodeHeatOn(): boolean {
  return useSyncExternalStore(subscribe, codeHeatOn, () => false);
}
