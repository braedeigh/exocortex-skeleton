/**
 * paneConversation.ts — the seam that lets a page in the RIGHT half of the
 * desktop split open a conversation in the LEFT pane's session tab (the middle
 * tab, next to Observatory) instead of navigating the whole right half away to
 * /observatory.
 *
 * Why a registry and not a window event: the caller needs an ANSWER. On mobile
 * — and for public visitors — there is no left pane at all, so the old
 * behaviour (navigate to the routed observatory page) is still the only thing
 * that can happen. `openConversationInPane` returns false in that case and the
 * caller falls through to `navigate(...)`. A fire-and-forget event couldn't
 * tell the caller whether anyone caught it, and the click would do nothing on
 * a phone.
 *
 * SplitLayout registers the one target while it's showing the authed desktop
 * pane; it flips the pane to the room, selects the middle tab, and hands the
 * id down to KeeperPane. Callers: TerrainPage (tapping an agent orb or a
 * session row on the map).
 *
 * Prompt that produced this: "i really want for when i click on an agent on
 * the terrain page, that opens that session on the left hand page middle tab
 * next to the observatory rather than the half of the split screen on the
 * right".
 */

type PaneConversationTarget = (convId: string) => void;

/** At most one — there's only ever one left pane. */
let target: PaneConversationTarget | null = null;

/** Claim the "open a conversation here" role. Returns an unregister for the
 * effect cleanup; it only clears the slot if this same target still holds it,
 * so a remount that registers before the old one cleans up doesn't blank it. */
export function registerPaneConversationTarget(fn: PaneConversationTarget): () => void {
  target = fn;
  return () => {
    if (target === fn) target = null;
  };
}

/** Ask the left pane to open `convId` in its session tab. False = there is no
 * pane (mobile, public, or the pane isn't mounted), so the caller should
 * navigate to the routed observatory page instead. */
export function openConversationInPane(convId: string): boolean {
  if (!target || !convId) return false;
  target(convId);
  return true;
}
