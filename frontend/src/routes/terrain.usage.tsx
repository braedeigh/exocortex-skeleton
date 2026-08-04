import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainUsageView } from '../features/terrain/TerrainUsageView';

/**
 * /terrain/usage — "where you actually go": the app's own places ranked by the
 * attention they get, read off the usage counters that have been running since
 * July (routes/usage.py, GET /api/usage).
 *
 * A CHILD of /terrain, not a sibling: the dot in this filename nests it, so
 * TerrainPage stays mounted and renders this through its <Outlet/>. That's what
 * makes it a page within a page — the map keeps running behind and around the
 * frame. Same auth guard as its parent, since it names repo-side surfaces.
 */
export const Route = createFileRoute('/terrain/usage')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: TerrainUsageView,
});
