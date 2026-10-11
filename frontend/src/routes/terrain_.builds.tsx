import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainBuildsView } from '../features/terrain/TerrainBuildsView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/builds — the Builds room: the owner's other git folders (projects
 * built elsewhere on this machine, repos cloned from GitHub), one card each,
 * and the box that adds another (features/terrain/TerrainBuildsView). A card
 * opens that build's own map at /terrain/files?build=<id>.
 *
 * Un-nested (the `terrain_.` prefix) like its neighbours, so the map unmounts
 * and this room owns the screen; "← Rooms" reopens the hallway.
 * Owner only: a build's file names and commit messages are hers, so a visitor
 * is redirected away here and the server refuses the data regardless.
 */
export const Route = createFileRoute('/terrain_/builds')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: BuildsRoute,
});

function BuildsRoute() {
  useDeactivateFrames();
  return <TerrainBuildsView />;
}
