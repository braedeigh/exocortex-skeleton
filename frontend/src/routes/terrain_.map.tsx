import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { TerrainMapView, type MapPlace } from '../features/terrain/TerrainMapView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/map — the Map room: a codebase drawn as boxes and named arrows
 * (features/terrain/TerrainMapView). Until 2026-10-02 this address was the
 * file heatmap, which is now Files at /terrain/files
 * (routes/terrain_.files.tsx).
 *
 * Old links must keep working. Two kinds of arrival still mean Files and are
 * forwarded there with their search intact (a replace, so "back" never lands
 * on this hop): a visitor — the Map is owner-only, and Files is the page a
 * visitor can open — and any address carrying a search key only Files
 * understands (embed, solo, journey, build, repo, file, mentions, of: a
 * bookmark, the portfolio page's iframe, a file link).
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
    const visitor = typeof window !== 'undefined' && window.VIEW_MODE === 'public';
    if (visitor || FILES_KEYS.some((key) => key in search)) {
      throw redirect({ to: '/terrain/files', search: search as never, replace: true });
    }
  },
  component: MapRoute,
});

function MapRoute() {
  useDeactivateFrames();
  const { map, at } = Route.useSearch();
  const navigate = useNavigate();
  const onGo = useCallback(
    (next: MapPlace) => navigate({ to: '/terrain/map', search: { ...(next.map ? { map: next.map } : {}), ...(next.at ? { at: next.at } : {}) } }),
    [navigate],
  );
  return <TerrainMapView mapKey={map} at={at} onGo={onGo} />;
}
