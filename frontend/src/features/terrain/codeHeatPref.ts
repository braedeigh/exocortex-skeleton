import { useSyncExternalStore } from 'react';

/**
 * codeHeatPref.ts — the two switches on an open file: whether its lines are
 * marked red by when they were last EDITED (FileCodeBody's "edits" toggle),
 * and whether they're marked gold by when their function last RAN (its "ran"
 * toggle). The colour for both comes from lineEditHeat.ts.
 *
 * Each is ONE setting across every file and every frame — the pane on the
 * map, the /code page, the pond's file panel — not one per file: once she
 * turns a mark on, every file she opens after that wears it until she turns
 * it off. The two are independent, so red and gold can be on together.
 * Same shape as backdropPref.ts, which is the pattern for "a toggle that
 * stays".
 *
 * Prompts that produced it: "show when the most recent code was edited by a
 * toggleable red color like on the terrain map"; and, for gold, "see which
 * function in a file ran, not just that the file ran".
 */

/**
 * Build one toggle that stays: a named on/off kept outside any component.
 *
 * This is an external store hook — React's name for a value kept outside any
 * component that components can subscribe to. Stored in localStorage under
 * `key` so it survives a reload, and broadcast two ways so every window
 * follows within the gesture: `listeners` for anything mounted in this
 * document, the browser's `storage` event for other tabs of the same origin.
 * Off unless she has explicitly turned it on — a file is plain text until
 * she asks for a mark. Exported for the map's own sticky switch
 * (typeColorPref.ts), so there is one implementation of the pattern.
 */
export function makeStickyToggle(key: string) {
  function fromStorage(): boolean {
    try {
      return localStorage.getItem(key) === 'on';
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
      if (e.key !== null && e.key !== key) return;
      const next = fromStorage();
      if (next === current) return;
      current = next;
      announce();
    });
  }

  function isOn(): boolean {
    return current;
  }

  function set(on: boolean): void {
    if (on === current) return;
    current = on;
    try {
      localStorage.setItem(key, on ? 'on' : 'off');
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

  /** The live value, re-rendering the caller whenever it changes anywhere;
   * off when rendered on a server. */
  function useOn(): boolean {
    return useSyncExternalStore(subscribe, isOn, () => false);
  }

  return { isOn, set, useOn };
}

// The red "edits" mark.
const editsToggle = makeStickyToggle('terrain-code-heat');
export const codeHeatOn = editsToggle.isOn;
export const setCodeHeatOn = editsToggle.set;
export const useCodeHeatOn = editsToggle.useOn;

// The gold "ran" mark.
const ranToggle = makeStickyToggle('terrain-code-ran');
export const codeRunOn = ranToggle.isOn;
export const setCodeRunOn = ranToggle.set;
export const useCodeRunOn = ranToggle.useOn;
