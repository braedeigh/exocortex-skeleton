import { listPanels, type LayoutNode, type PanelNode } from './layoutTree';
import { convIdOf, pathOf } from './sections';

/**
 * activityRouting.ts — where a session's Activity pane opens in a window.
 *
 * The session toolbar's "activity" button asks for one session's activity
 * (features/terrain/activity/ActivityPage.tsx). On a wide screen the answer is a
 * panel beside the session, and the rule, checked in order, is:
 *
 *   1. A panel already SHOWING this session's activity → open nothing, point
 *      at it ('reveal' — the workspace flashes that panel).
 *   2. A panel showing SOME activity page (another session's, or the picker)
 *      → it switches to this session. One activity panel gets reused rather
 *      than a new one piling up per session.
 *   3. Otherwise a new pane is born to the RIGHT of the panel holding the
 *      conversation ('split'), or of the primary panel if the conversation
 *      isn't in any panel.
 *
 * Pure functions over the layout tree, the same contract as
 * conversationRouting.ts: no React, no DOM, tested in activityRouting.test.ts.
 *
 * Touches: Workspace.tsx (registers the catcher and applies the action),
 * sections.ts (reading a panel's url), features/terrain/activity/openActivity.ts
 * (the sender).
 */

export type ActivityAction =
  | { kind: 'reveal'; panelId: string }
  | { kind: 'show'; panelId: string; isPrimary: boolean; url: string }
  | { kind: 'split'; targetId: string; url: string };

export const ACTIVITY_PATH = '/terrain/activity';

/** The one url shape for a session's activity. */
export function activityUrl(convId: string): string {
  return `${ACTIVITY_PATH}?agent=${encodeURIComponent(convId)}`;
}

function agentOf(url: string): string | null {
  if (pathOf(url) !== ACTIVITY_PATH) return null;
  return new URLSearchParams(url.split('?')[1] ?? '').get('agent');
}

function urlOf(panel: PanelNode, primaryHref: string): string {
  return panel.kind === 'primary' ? primaryHref : (panel.url ?? '');
}

/** Where `convId`'s activity should open — the rule above, in order. Null
 *  only for a layout with no routable panels at all. */
export function routeActivity(
  layout: LayoutNode,
  convId: string,
  primaryHref: string,
): ActivityAction | null {
  const panels = listPanels(layout).filter((p) => p.kind !== 'pane');
  if (panels.length === 0) return null;
  const url = activityUrl(convId);

  // 1. Already in front of her.
  for (const p of panels) {
    if (agentOf(urlOf(p, primaryHref)) === convId) return { kind: 'reveal', panelId: p.id };
  }

  // 2. An activity panel for something else takes it over.
  for (const p of panels) {
    if (pathOf(urlOf(p, primaryHref)) === ACTIVITY_PATH) {
      return { kind: 'show', panelId: p.id, isPrimary: p.kind === 'primary', url };
    }
  }

  // 3. A new pane beside the conversation.
  const home =
    panels.find((p) => convIdOf(urlOf(p, primaryHref)) === convId) ??
    panels.find((p) => p.kind === 'primary') ??
    panels[0];
  return { kind: 'split', targetId: home.id, url };
}
