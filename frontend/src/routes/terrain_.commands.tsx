import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainCommandsView } from '../features/terrain/TerrainCommandsView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/commands — "which skills you reach for": every slash command in
 * ~/.claude/commands ranked by how often it actually gets called, read off the
 * Claude Code transcripts by commandstore.py (GET /api/usage/commands).
 *
 * Un-nested (the `terrain_.` prefix) like its neighbours, so the map unmounts
 * and this room owns the screen; "← Rooms" reopens the hallway. Same
 * auth guard as the rest of the terrain, since it names repo-side surfaces.
 */
export const Route = createFileRoute('/terrain_/commands')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: CommandsRoute,
});

function CommandsRoute() {
  useDeactivateFrames();
  return <TerrainCommandsView />;
}
