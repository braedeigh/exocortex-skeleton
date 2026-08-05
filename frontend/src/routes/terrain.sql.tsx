import { createFileRoute, redirect } from '@tanstack/react-router';
import { TerrainSqlView } from '../features/terrain/TerrainSqlView';

/**
 * /terrain/sql — the database as a room inside the terrain: the collection map,
 * the read-only console, and the sandbox (features/sqlab).
 *
 * A CHILD of /terrain, like /terrain/usage — the dot in this filename nests it,
 * so TerrainPage stays mounted and renders this through its <Outlet/>, with the
 * map still running around the frame. Same auth guard as its parent: it names
 * collections and table structure, so public visitors bounce to '/'.
 *
 * /sql still exists as a standalone full-width page and renders the same
 * component; this is a second door, not a move.
 */
export const Route = createFileRoute('/terrain/sql')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: TerrainSqlView,
});
