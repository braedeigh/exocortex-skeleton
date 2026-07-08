/**
 * frameStore.ts — registry of same-origin iframe "views" the shell keeps
 * mounted once visited, mirroring split.html's lazy-load-then-keep-mounted
 * iframes (dashboardFrame, journalFrame, researchFrame, filesFrame,
 * settingsFrame — never recreated, only display:none/block toggled).
 *
 * Each entry is keyed by a stable string (`legacy:<tab>`, `journal`,
 * `research`, `settings`, `files`). A route's job is just to call
 * `activateFrame` with the entry it wants visible; `FrameHost` renders every
 * entry that has ever been activated and shows/hides via CSS, so iframe
 * state (scroll position, in-page JS state) survives switching away and back.
 */

export interface FrameEntry {
  key: string;
  src: string;
  title: string;
}

type Listener = () => void;

const registry = new Map<string, FrameEntry>();
const frameWindows = new Map<string, Window>();
const listeners = new Set<Listener>();

let active: string | null = null;
let entriesSnapshot: FrameEntry[] = [];
let activeSnapshot: string | null = null;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEntriesSnapshot(): FrameEntry[] {
  return entriesSnapshot;
}

export function getActiveSnapshot(): string | null {
  return activeSnapshot;
}

/** Mount (if new) and show `entry`. Notifies the previously-active frame it lost focus. */
export function activateFrame(entry: FrameEntry): void {
  const previous = active;
  let changed = false;

  if (!registry.has(entry.key)) {
    registry.set(entry.key, entry);
    entriesSnapshot = Array.from(registry.values());
    changed = true;
  }

  if (active !== entry.key) {
    active = entry.key;
    activeSnapshot = active;
    changed = true;
  }

  if (changed) {
    emit();
    postTabActive(entry.key, true);
    if (previous && previous !== entry.key) postTabActive(previous, false);
  }
}

/** Hide every mounted frame — used by native (non-iframe) routes like /todos. */
export function deactivateFrames(): void {
  if (active === null) return;
  const previous = active;
  active = null;
  activeSnapshot = null;
  emit();
  if (previous) postTabActive(previous, false);
}

export function registerFrameWindow(key: string, win: Window): void {
  frameWindows.set(key, win);
}

export function unregisterFrameWindow(key: string): void {
  frameWindows.delete(key);
}

export function getFrameWindows(): ReadonlyMap<string, Window> {
  return frameWindows;
}

function postTabActive(key: string, isActive: boolean): void {
  const win = frameWindows.get(key);
  if (!win) return;
  try {
    win.postMessage({ type: 'tabActive', active: isActive }, window.location.origin);
  } catch {
    // frame torn down mid-flight — ignore
  }
}
