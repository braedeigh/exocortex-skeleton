/** Pure logic for the Movement tab — ported from static/js/movement.js. */

/**
 * Pull the 11-char YouTube id out of watch / youtu.be / embed / shorts URLs.
 * Returns '' for non-YouTube or empty URLs (those fall back to a plain link).
 * Exact port of movement.js `_ytId`.
 */
export function ytId(url: string | null | undefined): string {
  if (!url) return '';
  const s = String(url).trim();
  let m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return '';
}

/** Thumbnail shown before the player is loaded (click-to-load keeps the tab light). */
export function youtubeThumbUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Embed URL used once a thumbnail is tapped — same params as the old tab
 * (autoplay, no related videos, modest branding, inline on iOS). */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
}

/**
 * Reorder math for the up/down arrows (movement.js `_moveReorder`): swap the
 * move with its neighbour in the given direction. Returns the new id order,
 * or null when the swap is impossible (id missing, or already at the edge).
 */
export function swapAdjacent(ids: readonly string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = ids.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** localStorage key for the "hide videos" focus mode — must stay exactly this
 * string so the preference survives the legacy → React cutover. */
export const HIDE_VIDEOS_KEY = 'movement_hide_videos';

export function readHideVideos(): boolean {
  try {
    return localStorage.getItem(HIDE_VIDEOS_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeHideVideos(hide: boolean): void {
  try {
    localStorage.setItem(HIDE_VIDEOS_KEY, hide ? '1' : '0');
  } catch {
    // private mode / storage disabled — the toggle still works for the session
  }
}
