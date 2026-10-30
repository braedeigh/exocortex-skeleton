import { listPanels, type LayoutNode, type PanelNode } from './layoutTree';
import { convIdOf, pathOf, sectionForUrl } from './sections';

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
 *   3. A panel SHOWING A CONVERSATION exists → it opens there as a new tab, so
 *      a session pane is reused rather than a new one piling up. A panel in
 *      front of her beats a hidden one (a hidden one comes forward if it's the
 *      only one); among those, the rightmost route panel, and the primary only
 *      if it's the only one — navigating it moves the real address bar.
 *   4. A panel on an OBSERVATORY page with no conversation exists → a new pane
 *      is born on its right ('split'), so the page she tapped stays where it is.
 *      The roster itself is preferred, a panel in front of her over a hidden one.
 *   5. NO observatory panel anywhere in the window → a new pane is born off the
 *      primary ('split' — half the window, readably big, opened on the
 *      conversation).
 *
 * A background tab in a panel sitting ON THE ROSTER doesn't count for rule 2:
 * switching that panel would take the roster away from under her thumb, the
 * very thing the session pane exists to avoid. The conversation opens in a pane
 * instead, and the old tab stays in the roster's row until she closes it.
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
 *
 * Touches: Workspace.tsx (registers the window-level catcher and applies
 * these actions), sections.ts (what a url means), panelIntents.ts (tiles no
 * longer catch conversations themselves).
 *
 * Prompt that produced it: "it will check if it's already an open pane in the
 * window, and if not, it opens another pane … it should open a new pane if
 * there is no observatory tab anywhere on that page". Then: "make it into a
 * pane on the right, and if there is already a session pane on the right, then
 * it will open into that".
 */

export type ConvAction =
  | { kind: 'reveal'; panelId: string }
  | { kind: 'show'; panelId: string; isPrimary: boolean; url: string }
  /** `dir` when the rule says which side; otherwise the workspace chooses from
   * the window's shape. */
  | { kind: 'split'; targetId: string; url: string; dir?: 'row' | 'col' };

/** One url shape for a conversation, same as panelIntents.urlForIntent —
 * `session` is the fixed placeholder segment every caller uses. */
export function conversationUrl(convId: string): string {
  return `/observatory/session?conv=${encodeURIComponent(convId)}`;
}

/** The Sessions page itself, as opposed to a page under it. */
const ROSTER_PATH = '/observatory';

function isObservatoryUrl(url: string): boolean {
  return sectionForUrl(url)?.id === 'observatory';
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
  for (const p of listPanels(layout)) {
    if (isObservatoryUrl(urlOf(p, primaryHref))) return true;
    if ((p.tabs ?? []).some((t) => isObservatoryUrl(t.url))) return true;
  }
  return false;
}

/** Where `convId` should open in this window — the rule set above, in order.
 * `hidden` is the panels automatic full screen has out of sight
 * (layoutTree.fullScreenPlan): they still count, but only after the ones in
 * front of her. Returns null only for a layout with no panels at all (can't
 * happen live). */
export function routeConversation(
  layout: LayoutNode,
  convId: string,
  primaryHref: string,
  hidden: ReadonlySet<string> = new Set(),
): ConvAction | null {
  const panels = listPanels(layout);
  if (panels.length === 0) return null;
  const url = conversationUrl(convId);
  const showing = (p: PanelNode) => urlOf(p, primaryHref);
  const onRoster = (p: PanelNode) => pathOf(showing(p)) === ROSTER_PATH;

  // 1. Already in front of her somewhere.
  for (const p of panels) {
    if (convIdOf(showing(p)) === convId) return { kind: 'reveal', panelId: p.id };
  }

  // 2. Open as a background tab — reuse that tab's own url, so whatever
  //    search params it carried survive the round trip.
  for (const p of panels) {
    if (onRoster(p)) continue;
    const tab = (p.tabs ?? []).find((t) => convIdOf(t.url) === convId);
    if (tab) return { kind: 'show', panelId: p.id, isPrimary: p.kind === 'primary', url: tab.url };
  }

  // 3. A panel showing a conversation takes it as a new tab. Lowest score wins;
  //    ties go to the rightmost, which is why this walks from the right.
  const reading = panels.filter((p) => convIdOf(showing(p)) !== null).reverse();
  if (reading.length > 0) {
    const score = (p: PanelNode) => (hidden.has(p.id) ? 2 : 0) + (p.kind === 'primary' ? 1 : 0);
    const best = reading.reduce((a, b) => (score(b) < score(a) ? b : a));
    return { kind: 'show', panelId: best.id, isPrimary: best.kind === 'primary', url };
  }

  // 4. A panel on an observatory page gets a new pane on its right.
  const pages = panels.filter((p) => isObservatoryUrl(showing(p)));
  if (pages.length > 0) {
    const score = (p: PanelNode) => (hidden.has(p.id) ? 2 : 0) + (onRoster(p) ? 0 : 1);
    const best = pages.reduce((a, b) => (score(b) < score(a) ? b : a));
    return { kind: 'split', targetId: best.id, url, dir: 'row' };
  }

  // 5. Nowhere observatory in sight — a new pane, split off the primary (the
  //    one panel every window has; direction is the workspace's call, it
  //    knows the window's shape).
  const primary = panels.find((p) => p.kind === 'primary') ?? panels[0];
  return { kind: 'split', targetId: primary.id, url };
}
