import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainSqlView } from '../features/terrain/TerrainSqlView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/sql — the database as a room of the terrain: the collection map,
 * the read-only console, and the sandbox (features/sqlab).
 *
 * Un-nested (the `terrain_.` prefix), same as /terrain/usage: this was an
 * inset glass panel over the live map, and its glass had to be pushed to 98%
 * opaque before a code editor was readable over moving dots — the clearest
 * sign it wanted to be a page. Now the map unmounts and this room owns the
 * screen; "← Rooms" reopens the hallway. The URL didn't move, so
 * routes/spa.py and old links are untouched.
 *
 * /sql still exists as a standalone full-width page rendering the same
 * SqlLabPage body; this is a second door, not a move. Same auth guard as its
 * siblings: it names collections and table structure.
 */
export const Route = createFileRoute('/terrain_/sql')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: SqlRoute,
});

function SqlRoute() {
  useDeactivateFrames();
  return <TerrainSqlView />;
}
