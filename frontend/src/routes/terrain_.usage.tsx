import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainUsageView } from '../features/terrain/TerrainUsageView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/usage — "where you actually go": the app's own places ranked by the
 * attention they get, read off the usage counters that have been running since
 * July (routes/usage.py, GET /api/usage).
 *
 * Un-nested (the `terrain_.` prefix): this used to be a child route rendered
 * inside TerrainPage's <Outlet/> as an inset glass panel, and it kept having
 * to fight the live map behind it for legibility. Now it's a whole page — the
 * map unmounts, this room owns the screen, and "← Terrain" walks back to
 * /terrain/map. The URL didn't move, so routes/spa.py and old links are
 * untouched. Same auth guard as the map, since it names repo-side surfaces.
 */
export const Route = createFileRoute('/terrain_/usage')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: UsageRoute,
});

function UsageRoute() {
  useDeactivateFrames();
  return <TerrainUsageView />;
}
