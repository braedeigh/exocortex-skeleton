/**
 * embed.ts — is this window the EMBED view of the Terrain map?
 *
 * `/terrain/files?embed=1` is the map cut down to sit in an <iframe> on the
 * owner's portfolio page: no chrome, the breathing heat preset, the Open
 * agent pool, and one "Open Terrain ↗" door to the full map (see
 * features/terrain/TerrainPage.tsx). The shell's own chrome (TopTabs) reads
 * this too, so the public header stays out of the frame.
 *
 * `/terrain/map?embed=map` is the second card on that page: the Map room cut
 * down the same way (features/terrain/TerrainMapView.tsx). It has its own
 * value because `/terrain/map?embed=1` is an old address of the first card
 * and must keep forwarding to Files (routes/terrain_.map.tsx).
 *
 * Read off the real URL rather than the router's search object because the
 * shell decides before any route has parsed anything, and because an embed
 * is one page — nothing navigates inside it.
 */
export function isEmbed(): boolean {
  if (typeof window === 'undefined') return false;
  return isEmbedSearch(window.location.search);
}

/** The test seam: the URL arrives as `?embed=1`, but the router re-serialises
 * its parsed search on load and writes `?embed=true` back — by the time a
 * component renders, that is what the address bar says. Both count. */
export function isEmbedSearch(search: string): boolean {
  const v = new URLSearchParams(search).get('embed');
  return v === '1' || v === 'true' || v === MAP_EMBED;
}

/** The `embed` value that means "the Map room as a card", not the heatmap. */
export const MAP_EMBED = 'map';
