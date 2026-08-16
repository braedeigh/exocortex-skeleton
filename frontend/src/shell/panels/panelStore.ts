import { useCallback, useEffect, useRef, useState } from 'react';
import { isLayoutNode, type LayoutNode, type PanelNode } from './layoutTree';

/**
 * panelStore.ts — remembering the workspace arrangement, and minting ids.
 *
 * WHERE IT'S KEPT, AND WHY THAT'S TWO PLACES. The live arrangement goes in
 * sessionStorage, which is per browser WINDOW. That's the whole point: with
 * two monitors you want one window arranged for the conversation and another
 * arranged for the map and a code file, and they must not overwrite each
 * other. localStorage — which every window shares — would make the second
 * window silently rearrange the first.
 *
 * But a brand new window with no arrangement shouldn't open blank either, so a
 * copy is ALSO written to localStorage as the "last arrangement you used", and
 * a fresh window starts from that copy and then goes its own way. Reload keeps
 * this window's layout; a new window inherits and diverges.
 *
 * WHAT IT OPENS ON. With nothing stored anywhere, the default is the reading
 * room beside the routed content — the exact two-box split the desktop had
 * before panels existed. Nothing about the app looks different until you
 * deliberately split something.
 *
 * Touches: layoutTree.ts (the shape it stores), Workspace.tsx (the only
 * caller).
 */

const LIVE_KEY = 'exo-workspace'; // sessionStorage — this window's arrangement
const SEED_KEY = 'exo-workspace-last'; // localStorage — what a new window starts from

/* Ids only have to be unique within one window's tree, and they're generated
   one at a time by user gestures, so a counter is plenty — no need for uuid.
   The prefix keeps them readable in devtools and in stored JSON. */
let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The arrangement the desktop has always had: reading room | routed content. */
export function defaultLayout(): LayoutNode {
  return {
    type: 'split',
    id: newId('split'),
    dir: 'row',
    sizes: [50, 50],
    children: [
      { type: 'panel', id: newId('panel'), kind: 'pane' },
      { type: 'panel', id: newId('panel'), kind: 'primary' },
    ],
  };
}

/**
 * A stored layout is only usable if it still contains exactly one primary
 * panel — that's the one wired to the browser URL and the tab strip, and a
 * tree with none (or two) would leave the app with no address bar (or two
 * fighting over it). Older or hand-edited JSON can fail this, so it's checked
 * on the way in rather than trusted.
 */
function usable(node: unknown): node is LayoutNode {
  if (!isLayoutNode(node)) return false;
  const primaries = countPrimary(node);
  return primaries === 1;
}

function countPrimary(node: LayoutNode): number {
  if (node.type === 'panel') return node.kind === 'primary' ? 1 : 0;
  return node.children.reduce((n, c) => n + countPrimary(c), 0);
}

function read(store: Storage | undefined, key: string): LayoutNode | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return usable(parsed) ? parsed : null;
  } catch {
    // Unparseable, or storage denied — fall through to the default.
    return null;
  }
}

function loadLayout(): LayoutNode {
  if (typeof window === 'undefined') return defaultLayout();
  // This window's own arrangement wins; then the last one used anywhere;
  // then the plain two-box default.
  return read(window.sessionStorage, LIVE_KEY) ?? read(window.localStorage, SEED_KEY) ?? defaultLayout();
}

/**
 * The live layout plus a setter that persists. Writes are debounced through a
 * frame because a resize drag fires on every pointer move, and serialising the
 * tree to two storages at 120Hz is pure waste.
 */
export function useLayout(): [LayoutNode, (next: LayoutNode | ((cur: LayoutNode) => LayoutNode)) => void] {
  const [layout, setLayoutState] = useState<LayoutNode>(loadLayout);
  const pending = useRef<number | null>(null);
  const latest = useRef(layout);
  latest.current = layout;

  useEffect(() => {
    if (pending.current !== null) cancelAnimationFrame(pending.current);
    pending.current = requestAnimationFrame(() => {
      pending.current = null;
      try {
        const raw = JSON.stringify(latest.current);
        window.sessionStorage.setItem(LIVE_KEY, raw);
        window.localStorage.setItem(SEED_KEY, raw);
      } catch {
        // Storage denied or full — the arrangement still works for this
        // session, it just won't survive a reload.
      }
    });
    return () => {
      if (pending.current !== null) cancelAnimationFrame(pending.current);
    };
  }, [layout]);

  const setLayout = useCallback((next: LayoutNode | ((cur: LayoutNode) => LayoutNode)) => {
    setLayoutState((cur) => (typeof next === 'function' ? next(cur) : next));
  }, []);

  return [layout, setLayout];
}

/** A fresh route panel. New panels open on the terrain map rather than blank:
 *  an empty box gives you nothing to react to, and the map is the page most
 *  likely to be the reason you split in the first place. */
export function newRoutePanel(url = '/terrain/map'): PanelNode {
  return { type: 'panel', id: newId('panel'), kind: 'route', url };
}
