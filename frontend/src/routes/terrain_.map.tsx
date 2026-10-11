import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { TerrainMapView, type MapPlace } from '../features/terrain/TerrainMapView';
import { MAP_EMBED } from '../shell/embed';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/map — the Map room: a codebase drawn as boxes and named arrows
 * (features/terrain/TerrainMapView). Until 2026-10-02 this address was the
 * file heatmap, which is now Files at /terrain/files
 * (routes/terrain_.files.tsx).
 *
 * Old links must keep working. An address carrying a search key only Files
 * understands (embed, solo, journey, build, repo, file, mentions, of: a
 * bookmark, the portfolio page's first iframe, a file link) still means Files
 * and is forwarded there with its search intact (a replace, so "back" never
 * lands on this hop).
 *
 * Open to visitors since 2026-10-04: the server hands a visitor only the maps
 * the owner opened (public_config.PUBLIC_MAPS), so the room no longer bounces
 * them. `?embed=map` is the room as a card on the portfolio page — the one
 * `embed` value that stays here instead of forwarding — and it rides along on
 * every step so the card never grows the site's chrome.
 *
 * The Map's own place is in the address: `?map=<repo>/<name>` picks the
 * codebase, `?at=<box id>` the box you're inside. Each step in is a new
 * history entry, so the back button walks back up the levels.
 */
const FILES_KEYS = ['embed', 'solo', 'journey', 'build', 'repo', 'file', 'mentions', 'of'];

export const Route = createFileRoute('/terrain_/map')({
  validateSearch: (raw: Record<string, unknown>): MapPlace & Record<string, unknown> => {
    // Files-only keys pass through untouched so beforeLoad can forward them.
    const passthrough = Object.fromEntries(FILES_KEYS.filter((key) => key in raw).map((key) => [key, raw[key]]));
    return {
      ...passthrough,
      ...(typeof raw.map === 'string' && /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/.test(raw.map) ? { map: raw.map } : {}),
      ...(typeof raw.at === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(raw.at) ? { at: raw.at } : {}),
    };
  },
  beforeLoad: ({ search }) => {
    if (FILES_KEYS.some((key) => key in search && !(key === 'embed' && search.embed === MAP_EMBED))) {
      throw redirect({ to: '/terrain/files', search: search as never, replace: true });
    }
  },
  component: MapRoute,
});

function MapRoute() {
  useDeactivateFrames();
  const { map, at, embed } = Route.useSearch();
  const card = embed === MAP_EMBED;
  const navigate = useNavigate();
  const onGo = useCallback(
    (next: MapPlace) =>
      navigate({
        to: '/terrain/map',
        search: {
          ...(next.map ? { map: next.map } : {}),
          ...(next.at ? { at: next.at } : {}),
          ...(card ? { embed: MAP_EMBED } : {}),
        },
      }),
    [navigate, card],
  );
  return <TerrainMapView mapKey={map} at={at} onGo={onGo} card={card} />;
}
