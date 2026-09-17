import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /terrain — the front door of the terrain, and nothing but a door: it
 * redirects straight to /terrain/map, where the force-directed file map
 * actually lives. The map moved to its own address (her ask: "I want for the
 * map to be terrain/view or something") so every surface under /terrain —
 * the map, /terrain/usage, /terrain/sql — is a full page of the same rank,
 * reached through the rooms index on the map.
 *
 * The map is public since 2026-09-17 (public_config.PUBLIC_PATHS; the other
 * rooms still bounce visitors), so this door forwards everyone.
 */
export const Route = createFileRoute('/terrain')({
  beforeLoad: () => {
    throw redirect({ to: '/terrain/map' });
  },
  component: () => null,
});
