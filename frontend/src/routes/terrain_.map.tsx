import { createFileRoute, redirect } from '@tanstack/react-router';
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
 * Auth-only, same guard as /atlas and /observatory: it surfaces repo
 * structure and session titles, so public visitors bounce to '/'.
 */
export const Route = createFileRoute('/terrain_/map')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: TerrainRoute,
});

function TerrainRoute() {
  useDeactivateFrames();
  return <TerrainPage />;
}
