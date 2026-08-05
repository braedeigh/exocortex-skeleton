import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainGrowthView } from '../features/terrain/TerrainGrowthView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/growth — the growth room of the terrain: the codebase and the
 * vault as curves over time (features/terrain/TerrainGrowthView), fed by the
 * code-history tables in exo.db.
 *
 * Un-nested (the `terrain_.` prefix) like its siblings /terrain/usage and
 * /terrain/sql: a full page of the same rank, reached through the rooms index
 * on the map; "← Terrain" walks back to /terrain/map. Same auth guard — it
 * names files, commit messages and session titles.
 */
export const Route = createFileRoute('/terrain_/growth')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: GrowthRoute,
});

function GrowthRoute() {
  useDeactivateFrames();
  return <TerrainGrowthView />;
}
