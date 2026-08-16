import { useSyncExternalStore } from 'react';

/**
 * queueOwner.ts — exactly one mounted view is allowed to fire a conversation's
 * queued messages.
 *
 * THE BUG THIS EXISTS FOR. A queued message waits in localStorage and fires
 * when the turn ends (useMessageQueue.ts). Each mounted view of a conversation
 * loads that queue into its own React state and runs its own firing effect —
 * so with the same conversation open twice, BOTH fire the head message and the
 * model receives it twice. It was always possible; tabs make it ordinary,
 * because a running session now opens itself as a live view whether or not one
 * is already open elsewhere.
 *
 * So: the first view to mount for a conversation claims it. Later views hold
 * and display the queue exactly as before — they just don't send. When the
 * owner goes away it hands the claim to whoever is still waiting, so closing
 * the tab that happened to be first doesn't strand the queue forever.
 *
 * A token, not a boolean: two views of the same conversation are otherwise
 * indistinguishable, and an unmounting one must not be able to release a claim
 * that has already passed to someone else.
 *
 * WHAT THIS DOESN'T COVER, stated plainly: ownership is per browser window.
 * The same conversation open in two WINDOWS can still double-fire, because
 * nothing here crosses windows. That's a narrower case than the one tabs
 * create, and closing it means a lease over the window bus with all the
 * expiry handling a lease needs.
 *
 * Touches: useMessageQueue.ts (the only caller).
 */

const owners = new Map<string, symbol>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string): void {
  for (const cb of listeners.get(key) ?? []) cb();
}

/** Take the claim if it's free, or confirm we already hold it. */
export function claim(key: string, token: symbol): boolean {
  const current = owners.get(key);
  if (current === token) return true;
  if (current !== undefined) return false;
  owners.set(key, token);
  notify(key);
  return true;
}

/**
 * Take the claim by force.
 *
 * Used when she types into a view: the view she is actually working in should
 * be the one that sends, whatever mounted first. Without this the claim goes
 * to whichever view happened to appear earliest, and a message queued in a
 * different one would sit there forever, held by a view that isn't allowed to
 * fire it.
 */
export function takeOver(key: string, token: symbol): void {
  if (owners.get(key) === token) return;
  owners.set(key, token);
  notify(key);
}

/** Give it up — but only if we still hold it. */
export function release(key: string, token: symbol): void {
  if (owners.get(key) !== token) return;
  owners.delete(key);
  // Whoever is still mounted re-claims on the next render.
  notify(key);
}

export function ownerOf(key: string): symbol | undefined {
  return owners.get(key);
}

export function subscribe(key: string, cb: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Test seam: forget every claim and listener. */
export function resetQueueOwnersForTests(): void {
  owners.clear();
  listeners.clear();
}

/**
 * True when this view is the one allowed to fire `key`'s queue.
 *
 * The claim is taken during render rather than in an effect, so a view never
 * spends a frame believing it may fire when it may not — that frame is exactly
 * long enough for the firing effect to run and send the message twice.
 * Claiming is idempotent and only touches a module map, so it's safe to repeat.
 */
export function useQueueOwnership(key: string, token: symbol): boolean {
  const owner = useSyncExternalStore(
    (cb) => subscribe(key, cb),
    () => ownerOf(key),
    () => undefined,
  );
  if (owner === undefined) claim(key, token);
  return ownerOf(key) === token;
}
