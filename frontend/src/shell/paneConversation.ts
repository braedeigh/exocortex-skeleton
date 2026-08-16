import { dispatchIntent } from './panels/windowBus';

/**
 * paneConversation.ts — "open this conversation somewhere other than here".
 *
 * Tapping an agent on the terrain map, or a session in the journal, shouldn't
 * throw away the page you're looking at. It used to hand the conversation to
 * the one left pane; now it hands it to the window bus, which finds a tile
 * that will take it — the reading room, an observatory tile, or one of those
 * in another window on another monitor (panels/windowBus.ts).
 *
 * The boolean is the whole point and is unchanged: the caller needs an answer
 * NOW so it can navigate instead. On a phone, for a public visitor, or with
 * every observatory tile closed, nothing accepts a conversation and the caller
 * falls through to the routed observatory page exactly as it always did.
 *
 * Callers: TerrainPage (an agent orb or session row on the map), JournalPage.
 *
 * Prompt that produced this: "i really want for when i click on an agent on
 * the terrain page, that opens that session on the left hand page middle tab
 * next to the observatory rather than the half of the split screen on the
 * right".
 */

/** Ask any tile, in any window, to open `convId`. False = nowhere took it, so
 * the caller should navigate to the routed observatory page instead. */
export function openConversationInPane(convId: string): boolean {
  if (!convId) return false;
  return dispatchIntent({ kind: 'conversation', convId }) !== 'none';
}
