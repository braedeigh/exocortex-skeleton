import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /terrain — the front door of the terrain, and nothing but a door: it
 * redirects straight to /terrain/files, Files, where the force-directed file
 * map lives. Every surface under /terrain — Files, the Map, /terrain/usage,
 * /terrain/sql and the rest — is a full page of the same rank, reached
 * through the rooms hallway (features/terrain/TerrainRoomsIndex.tsx).
 *
 * Files is public since 2026-09-17 (public_config.PUBLIC_PATHS; the other
 * rooms still bounce visitors), so this door forwards everyone.
 */
export const Route = createFileRoute('/terrain')({
  beforeLoad: () => {
    throw redirect({ to: '/terrain/files' });
  },
  component: () => null,
});
