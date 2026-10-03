/**
 * agentHoverBus.ts — "the mouse is on this agent", said by one tile and heard
 * by the others.
 *
 * What this is, in plain English: with the Observatory in one tile and the
 * Terrain map in another, pointing at an agent in the Observatory (a session
 * card, a member of a swarm, a ring in a swarm's drawing) lights that agent's
 * orb on the map. This file is the wire between them. One side says which
 * agent the mouse is on; the other side listens.
 *
 * It sits beside windowBus.ts and is separate from it on purpose. That bus
 * carries one-off requests ("open this over there") to ONE chosen tile. A
 * hover is a different kind of thing: it changes many times a second, every
 * listener hears it, and it has to END. So this file keeps a single current
 * value and tells listeners whenever it changes.
 *
 * Tiles in the same browser window share this file's memory, so they hear
 * each other directly. Another browser window (a second monitor) hears it
 * over a BroadcastChannel.
 *
 * Mouse only. A finger has no hover, and the split screen this is for only
 * exists on a desktop (shell/SplitLayout.tsx).
 *
 * Touches: observatory/SessionCard.tsx, SwarmStack.tsx, SwarmCard.tsx,
 * SwarmNetwork.tsx and RoomMap.tsx (they say which agent is pointed at),
 * terrain/TerrainPage.tsx (it listens, and lights the orb).
 *
 * Prompt that produced it: "if terrain is on one side of the split screen and
 * the observatory is on the left ... if I hover over an agent on the
 * observatory, it highlights it on terrain."
 */
import type { PointerEvent as ReactPointerEvent } from 'react';

const CHANNEL = 'exo-agent-hover';

type Listener = (convId: string | null) => void;

const listeners = new Set<Listener>();
/** The agent the mouse is on in THIS window, and the element it is over. */
let localConv: string | null = null;
let localElement: Element | null = null;
/** The agent the mouse is on in another browser window. */
let remoteConv: string | null = null;
let channel: BroadcastChannel | null = null;
let watching = false;

/** The agent being pointed at right now, in any tile or window; null for none. */
export function pointedAgent(): string | null {
  return localConv ?? remoteConv;
}

/** Tell every listener, but only when the answer actually changed. */
let lastTold: string | null = null;
function tell(): void {
  const now = pointedAgent();
  if (now === lastTold) return;
  lastTold = now;
  for (const listener of [...listeners]) listener(now);
}

/** Open the line to other browser windows, once. Absent in the node test
 * environment; the bus still works inside one window without it. */
function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    const conv: unknown = event.data?.conv;
    remoteConv = typeof conv === 'string' ? conv : null;
    tell();
  };
  // A window that closes mid-hover says so, or the others would stay lit.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => post(null));
  }
  return channel;
}

function post(conv: string | null): void {
  try {
    channel?.postMessage({ conv });
  } catch {
    // A window mid-teardown can refuse to post; a missed hover costs nothing.
  }
}

/**
 * Notice when the mouse has left the pointed-at element, and clear the hover.
 *
 * One watcher on the whole document rather than a leave handler on every
 * card, because a card can vanish from under the mouse (the roster polls and
 * re-sorts) and a vanished element never reports a leave. The next mouse
 * move anywhere finds it gone. Moving off the window clears it too.
 */
function ensureWatcher(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('pointermove', (event) => {
    if (localElement === null) return;
    const target = event.target;
    const stillOn = localElement.isConnected && target instanceof Node && localElement.contains(target);
    if (!stillOn) pointAtAgent(null);
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => pointAtAgent(null));
  window.addEventListener('blur', () => pointAtAgent(null));
}

/** Say which agent the mouse is on (null for none). `element` is what the
 * mouse is over, so the watcher can tell when it has left. */
export function pointAtAgent(convId: string | null, element: Element | null = null): void {
  ensureChannel();
  if (localConv === convId && localElement === (convId === null ? null : element)) return;
  const changed = localConv !== convId;
  localConv = convId;
  localElement = convId === null ? null : element;
  if (!changed) return;
  post(convId);
  tell();
}

/** Hear every change of the pointed-at agent. Returns the way to stop. */
export function subscribeAgentHover(listener: Listener): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The props that make an element stand for one agent: spread them on a card,
 * a button or a ring, and pointing the mouse at it points at that agent.
 * There is no leave handler; the document watcher above ends the hover.
 */
export function agentPointerProps(convId: string): {
  onPointerEnter: (event: ReactPointerEvent<Element>) => void;
} {
  return {
    onPointerEnter: (event) => {
      if (event.pointerType !== 'mouse') return;
      ensureWatcher();
      pointAtAgent(convId, event.currentTarget);
    },
  };
}

/** Test seam: forget the hover, the listeners and the channel. */
export function resetAgentHoverForTests(): void {
  listeners.clear();
  localConv = null;
  localElement = null;
  remoteConv = null;
  lastTold = null;
  channel?.close();
  channel = null;
}
