import { useCallback, useRef } from 'react';

/**
 * sessionMountKey.ts — the React `key` a chat page is mounted under, so that a
 * brand-new session's first reply keeps streaming live.
 *
 * Both homes of the chat page (the routed page and the docked pane in
 * shell/KeeperPane.tsx) key it on the conversation id, so that switching
 * conversations starts from a clean page. But a blank compose has no id until
 * its first send creates one — and pointing the URL (or the pane) at that new
 * id mid-reply would change the key, throw the page away, and cut the live
 * stream, leaving only the 2-second log poll (useReattach.ts) to show the
 * reply. So the page ADOPTS the id it just made: it says so (adopt) before it
 * moves the URL, and the key stays the one the blank compose had. Going
 * anywhere else afterwards retires the adoption and bumps a generation, so the
 * next blank compose gets a key of its own and never inherits the old page.
 *
 * Touches: routes/observatory_.$botId.tsx and shell/KeeperPane.tsx (the two
 * callers), ObservatoryPage.tsx (calls adopt via its onSessionCreated prop).
 */

export interface MountKeyState {
  /** The id the current blank-compose mount created and now stands on. */
  adopted: string | null;
  /** Bumped each time an adoption ends, so blank keys never repeat. */
  generation: number;
}

export const INITIAL_MOUNT_KEY: MountKeyState = { adopted: null, generation: 0 };

/** The key for `conv`, and the state to carry forward. A blank compose, and
 * the session it adopted, share `new-<generation>`; any other conversation is
 * keyed by its own id. */
export function mountKeyFor(
  state: MountKeyState,
  conv: string | undefined,
): { state: MountKeyState; key: string } {
  let next = state;
  if (next.adopted !== null && next.adopted !== conv) {
    next = { adopted: null, generation: next.generation + 1 };
  }
  const key = conv === undefined || conv === next.adopted ? `new-${next.generation}` : conv;
  return { state: next, key };
}

/** Mark `conv` as the session the blank compose just created. */
export function adoptSession(state: MountKeyState, conv: string): MountKeyState {
  return { ...state, adopted: conv };
}

/** The hook both homes use: the key to mount the page under, and the adopt
 * callback to hand the page. State lives in a ref — it only matters at the
 * next render, which the URL change is about to cause anyway. */
export function useSessionMountKey(conv: string | undefined): { key: string; adopt: (conv: string) => void } {
  const stateRef = useRef<MountKeyState>(INITIAL_MOUNT_KEY);
  const { state, key } = mountKeyFor(stateRef.current, conv);
  stateRef.current = state;
  const adopt = useCallback((id: string) => {
    stateRef.current = adoptSession(stateRef.current, id);
  }, []);
  return { key, adopt };
}
