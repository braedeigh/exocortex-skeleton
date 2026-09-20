import { mentionsToSearch, type CodeMentions } from '../features/terrain/codeMentions';

/**
 * solo.ts — is this window a SOLO window: one page, and nothing else?
 *
 * `/code?repo=…&path=…&solo=1` is a file popped out of the Terrain map into
 * its own browser tab (the ↗ button beside the × in
 * features/terrain/FileCodeWindow.tsx). A normal window on a desktop opens
 * the whole tiling workspace — the Observatory, the tab bars, every tile she
 * had open — and a popped-out file wants none of that: the file is the only
 * pane. SplitLayout.tsx reads this and, when it's on, hands the page the
 * whole window with no workspace and no tab strip around it.
 *
 * Read off the real URL rather than the router's search object because the
 * shell decides before any route has parsed anything — the same reason, and
 * the same shape, as shell/embed.ts. routes/code.tsx keeps `solo` in its
 * search schema so the router doesn't strip it from the address bar on load.
 *
 * Her ask: "open a code window in a new browser window by clicking a button,
 * where it becomes the only pane."
 */
export function isSolo(): boolean {
  if (typeof window === 'undefined') return false;
  return isSoloSearch(window.location.search);
}

/** The test seam: the URL arrives as `?solo=1`, but the router re-serialises
 * its parsed search on load and writes `?solo=true` back — by the time a
 * component renders, that is what the address bar says. Both count. */
export function isSoloSearch(search: string): boolean {
  const v = new URLSearchParams(search).get('solo');
  return v === '1' || v === 'true';
}

/** Build the address of a file's solo window. Lives here, beside the reader,
 * so the one place that writes `solo=1` and the one that reads it can't
 * drift apart. Mentions ride along when there are any, so a file popped out
 * of a table's card opens where it names that table rather than at line 1
 * (features/terrain/codeMentions.ts spells those params). */
export function soloCodeHref(repo: string, path: string, mentions?: CodeMentions): string {
  const search = new URLSearchParams({ repo, path, solo: '1', ...mentionsToSearch(mentions) });
  return `/code?${search.toString()}`;
}
