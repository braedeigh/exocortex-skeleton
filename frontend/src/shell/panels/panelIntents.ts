import type { Intent, IntentKind } from './windowBus';

/**
 * panelIntents.ts — which tiles catch what, and where a caught thing sends the
 * tile.
 *
 * A route tile's job is decided by the page it's showing: a tile on the code
 * reader is where code files should open, a tile on the observatory is where
 * conversations should open. Nothing has to be configured — point a tile at
 * /code and it becomes the code tile. Point a second one there and the last
 * one you touched wins (windowBus.ts ranks them).
 *
 * Kept apart from the component so both directions can be checked without
 * rendering anything (panelIntents.test.ts), and so there's ONE place that
 * spells these URLs — the conversation URL in particular has a dead `$botId`
 * segment that entry points used to disagree about
 * (features/observatory/sessionLocation.ts).
 *
 * Touches: RoutePanel.tsx (registers with these), windowBus.ts (the kinds).
 */

/** What a tile showing `url` is willing to catch. Empty = it's just a page. */
export function intentKindsForUrl(url: string): IntentKind[] {
  const path = url.split('?')[0].replace(/\/$/, '') || '/';
  if (path === '/code') return ['code'];
  // The roster and a conversation are the same tile as far as this is
  // concerned — sending a conversation to a tile showing the roster should
  // open it there rather than skip past to some other tile.
  if (path === '/observatory' || path.startsWith('/observatory/')) return ['conversation'];
  return [];
}

/** Where a tile should point itself once it catches something. */
export function urlForIntent(intent: Intent): string | null {
  if (intent.kind === 'code') {
    const q = new URLSearchParams({ repo: intent.repo, path: intent.path });
    return `/code?${q.toString()}`;
  }
  if (intent.kind === 'conversation') {
    // The `session` segment is the fixed placeholder every caller uses; the
    // conversation id travels in ?conv= (see sessionLocation.ts).
    return `/observatory/session?conv=${encodeURIComponent(intent.convId)}`;
  }
  // A tmux session isn't a page — only the reading room's terminal takes those.
  return null;
}
