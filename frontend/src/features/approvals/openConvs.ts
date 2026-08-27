/**
 * openConvs — which Observatory conversations are on screen in THIS window.
 *
 * Why it exists: a staged change can carry the `conv` it came out of. If that
 * conversation's pane is open here, the approval should pop over that pane
 * (ConversationApprovals), not as the window-wide sheet — and it must not do
 * both. So each ObservatoryPage registers its convId while mounted, the
 * global ApprovalsHost skips anything a mounted pane will handle, and the
 * pane picks up exactly its own. A tiny subscribe-able Set; no store library.
 *
 * Only this window: a conversation open in another browser window can't
 * claim it, so there the global host shows it — which is right, because
 * that's the only place the owner would see it.
 */
const open = new Map<string, number>(); // convId -> mount count
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function registerOpenConv(convId: string): () => void {
  open.set(convId, (open.get(convId) ?? 0) + 1);
  emit();
  return () => {
    const n = (open.get(convId) ?? 1) - 1;
    if (n <= 0) open.delete(convId);
    else open.set(convId, n);
    emit();
  };
}

export function isConvOpen(convId: string | null | undefined): boolean {
  return !!convId && open.has(convId);
}

export function subscribeOpenConvs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test/reset hook. */
export function _resetOpenConvs(): void {
  open.clear();
  emit();
}

/** Split a queue between the panes that own items and the global host.
 * `ownedBy(conv)` = the items a pane for `conv` should show; `unowned()` =
 * everything the global host shows (no conv, or conv not open here). */
export function itemsForConv<T extends { conv?: string | null }>(items: T[], convId: string): T[] {
  return items.filter((p) => p.conv === convId);
}

export function itemsUnowned<T extends { conv?: string | null }>(items: T[]): T[] {
  return items.filter((p) => !isConvOpen(p.conv));
}
