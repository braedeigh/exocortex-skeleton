import { createFileRoute } from '@tanstack/react-router';
import { TerrainPage } from '../features/terrain/TerrainPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/map — the file-tree heatmap itself: where the observatory's
 * sessions have been working, files glowing ember by recency. This is where
 * /terrain lands (it's a bare redirect here), and the page the other rooms'
 * "← Terrain" buttons return to.
 *
 * Un-nested (the `terrain_.` prefix) like the other terrain rooms: each is a
 * whole page, not a panel inside a parent — the rooms index on this map is
 * how you walk between them.
 *
 * Public since 2026-09-17 — the one Terrain room a visitor can enter
 * (public_config.PUBLIC_PATHS). It surfaces repo structure and session
 * titles, and the owner decided that's fine; what a visitor can't do is READ
 * a personal file (the server answers 403, the code window says "private")
 * or reach the roster, flow, traces or the other rooms — TerrainPage's
 * `visitor` flag turns those off on the page, the server gate is the lock.
 */
export const Route = createFileRoute('/terrain_/map')({
  // `?journey=<id>` opens the map with that capture ready to replay (the
  // Wiring room links here).
  validateSearch: (raw: Record<string, unknown>): { journey?: string } =>
    typeof raw.journey === 'string' && raw.journey ? { journey: raw.journey } : {},
  component: TerrainRoute,
});

function TerrainRoute() {
  useDeactivateFrames();
  return <TerrainPage />;
}
