import { listPanels, type LayoutNode, type PanelNode } from './layoutTree';
import { convIdOf, sectionForUrl } from './sections';

/**
 * conversationRouting.ts — where a conversation opens in a window, as a rule.
 *
 * "Open there" used to mean "whichever observatory tile was touched last
 * navigates away from whatever it was showing" — so two agents kept evicting
 * each other from one pane. This file replaces that with the owner's rule,
 * checked in order:
 *
 *   1. Already VISIBLE in some panel → open nothing; just point at it
 *      ('reveal' — the workspace flashes that panel).
 *   2. Open as a BACKGROUND TAB in some panel → that panel switches to it.
 *   3. An OBSERVATORY-FAMILY panel exists (the roster, or another
 *      conversation) → it opens there as a new tab — tabs are the
 *      multiplexer. Preference among candidates: a route panel on the roster
 *      (a launcher, built to be navigated) beats one reading another
 *      conversation, and the primary panel comes last — navigating it moves
 *      the real address bar, the most disruptive move on the list.
 *   4. NO observatory panel anywhere in the window → a new pane is born
 *      ('split' — half the window, readably big, opened on the conversation).
 *
 * Never two copies of one conversation, never a silent no-op, and a new pane
 * only when the window truly had nowhere to put it.
 *
 * `windowAcceptsConversations` is the gate on the whole game: a window with no
 * observatory presence at all — no such panel and no such tab (a pure
 * watching monitor: terrain + flow) — does not claim conversations, so the
 * bus carries them to a window that does.
 *
 * Pure functions over the layout tree, same contract as layoutTree.ts: no
 * React, no DOM, testable without rendering (conversationRouting.test.ts).
 * The reading-room panel is ignored throughout — when one exists the
 * workspace defers to its own legacy conversation seam (PaneStack).
 *
 * Touches: Workspace.tsx (registers the window-level catcher and applies
 * these actions), sections.ts (what a url means), panelIntents.ts (tiles no
 * longer catch conversations themselves).
 *
 * Prompt that produced it: "it will check if it's already an open pane in the
 * window, and if not, it opens another pane … it should open a new pane if
 * there is no observatory tab anywhere on that page".
 */

export type ConvAction =
  | { kind: 'reveal'; panelId: string }
  | { kind: 'show'; panelId: string; isPrimary: boolean; url: string }
  | { kind: 'split'; targetId: string; url: string };

/** One url shape for a conversation, same as panelIntents.urlForIntent —
 * `session` is the fixed placeholder segment every caller uses. */
export function conversationUrl(convId: string): string {
  return `/observatory/session?conv=${encodeURIComponent(convId)}`;
}

function isObservatoryUrl(url: string): boolean {
  return sectionForUrl(url)?.id === 'observatory';
}

/** The panels that can hold a conversation — everything but the reading room. */
function routablePanels(layout: LayoutNode): PanelNode[] {
  return listPanels(layout).filter((p) => p.kind !== 'pane');
}

function urlOf(panel: PanelNode, primaryHref: string): string {
  return panel.kind === 'primary' ? primaryHref : (panel.url ?? '');
}

/**
 * Should this window claim conversations at all? Yes iff it has observatory
 * presence somewhere — a panel showing an observatory page, or an observatory
 * tab in any panel's bar. A window without any (terrain fullscreen, a pure
 * code window) stays quiet and lets another window catch.
 */
export function windowAcceptsConversations(layout: LayoutNode, primaryHref: string): boolean {
  for (const p of routablePanels(layout)) {
    if (isObservatoryUrl(urlOf(p, primaryHref))) return true;
    if ((p.tabs ?? []).some((t) => isObservatoryUrl(t.url))) return true;
  }
  return false;
}

/** Where `convId` should open in this window — the rule set above, in order.
 * Returns null only for a layout with no panels at all (can't happen live). */
export function routeConversation(
  layout: LayoutNode,
  convId: string,
  primaryHref: string,
): ConvAction | null {
  const panels = routablePanels(layout);
  if (panels.length === 0) return null;
  const url = conversationUrl(convId);

  // 1. Already in front of her somewhere.
  for (const p of panels) {
    if (convIdOf(urlOf(p, primaryHref)) === convId) return { kind: 'reveal', panelId: p.id };
  }

  // 2. Open as a background tab — reuse that tab's own url, so whatever
  //    search params it carried survive the round trip.
  for (const p of panels) {
    const tab = (p.tabs ?? []).find((t) => convIdOf(t.url) === convId);
    if (tab) return { kind: 'show', panelId: p.id, isPrimary: p.kind === 'primary', url: tab.url };
  }

  // 3. An observatory-family panel takes it as a new tab. Roster route panels
  //    first, then conversation route panels, primary last (see header).
  const score = (p: PanelNode): number => {
    const showing = urlOf(p, primaryHref);
    if (!isObservatoryUrl(showing)) return Infinity;
    if (p.kind === 'primary') return 2;
    return convIdOf(showing) === null ? 0 : 1;
  };
  const best = panels.reduce((a, b) => (score(b) < score(a) ? b : a));
  if (score(best) !== Infinity) {
    return { kind: 'show', panelId: best.id, isPrimary: best.kind === 'primary', url };
  }

  // 4. Nowhere observatory in sight — a new pane, split off the primary (the
  //    one panel every window has; direction is the workspace's call, it
  //    knows the window's shape).
  const primary = panels.find((p) => p.kind === 'primary') ?? panels[0];
  return { kind: 'split', targetId: primary.id, url };
}
