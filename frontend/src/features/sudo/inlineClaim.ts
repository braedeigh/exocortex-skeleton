/**
 * inlineClaim.ts — "is the roster already showing the sudo cards?"
 *
 * A tiny shared counter: SudoRequests adds one while it's mounted, SudoHost
 * reads it and stays hidden while it's above zero. This is the same
 * subscribe/snapshot shape as approvals/openConvs.ts, for useSyncExternalStore.
 */
let count = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/** Mark the inline cards as on screen; returns the undo, for a useEffect cleanup. */
export function claimInline() {
  count += 1;
  emit();
  return () => {
    count -= 1;
    emit();
  };
}

export function subscribeInline(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function inlineShown() {
  return count > 0;
}
