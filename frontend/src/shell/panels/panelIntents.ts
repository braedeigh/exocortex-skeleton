import { mentionsToSearch } from '../../features/terrain/codeMentions';
import { activityUrl } from './activityRouting';
import type { Intent, IntentKind } from './windowBus';

/**
 * panelIntents.ts — which tiles catch what, and where a caught thing sends the
 * tile.
 *
 * A route tile's job is decided by the page it's showing: a tile on the code
 * reader is where code files should open. Nothing has to be configured —
 * point a tile at /code and it becomes the code tile. Point a second one
 * there and the last one you touched wins (windowBus.ts ranks them).
 *
 * CONVERSATIONS ARE NOT CAUGHT PER-TILE ANY MORE. Where a conversation opens
 * is a decision about the whole WINDOW — is it already visible, is it a
 * background tab, is there an observatory panel to take it, or does a pane
 * need to be born — so the workspace registers one window-level catcher and
 * decides with conversationRouting.ts. A tile catching for itself would
 * shadow that rule.
 *
 * Kept apart from the component so both directions can be checked without
 * rendering anything (panelIntents.test.ts), and so there's ONE place that
 * spells these URLs — the conversation URL in particular has a dead `$botId`
 * segment that entry points used to disagree about
 * (features/observatory/sessionLocation.ts).
 *
 * Touches: RoutePanel.tsx (registers with these), windowBus.ts (the kinds),
 * Workspace.tsx + conversationRouting.ts (the conversation side).
 */

/** What a tile showing `url` is willing to catch. Empty = it's just a page. */
export function intentKindsForUrl(url: string): IntentKind[] {
  const path = url.split('?')[0].replace(/\/$/, '') || '/';
  if (path === '/code') return ['code'];
  return [];
}

/** Where a tile should point itself once it catches something. */
export function urlForIntent(intent: Intent): string | null {
  if (intent.kind === 'code') {
    // The mentions ride in the URL, so a file caught by another tile opens
    // where it names the table she asked about — the same landing the map's
    // own pane gives it (features/terrain/codeMentions.ts).
    const q = new URLSearchParams({
      repo: intent.repo,
      path: intent.path,
      ...mentionsToSearch(
        intent.mentions && intent.mentions.length > 0
          ? { label: intent.mentionsOf ?? '', lines: intent.mentions }
          : undefined,
      ),
    });
    return `/code?${q.toString()}`;
  }
  if (intent.kind === 'conversation') {
    // The `session` segment is the fixed placeholder every caller uses; the
    // conversation id travels in ?conv= (see sessionLocation.ts).
    return `/observatory/session?conv=${encodeURIComponent(intent.convId)}`;
  }
  if (intent.kind === 'activity') return activityUrl(intent.convId);
  // A tmux session isn't a page — only the reading room's terminal takes those.
  return null;
}
