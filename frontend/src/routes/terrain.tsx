import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /terrain — the front door of the terrain, and nothing but a door: it
 * redirects straight to /terrain/map, where the force-directed file map
 * actually lives. The map moved to its own address (her ask: "I want for the
 * map to be terrain/view or something") so every surface under /terrain —
 * the map, /terrain/usage, /terrain/sql — is a full page of the same rank,
 * reached through the rooms index on the map.
 *
 * Auth-only, same guard as the pages it forwards to: public visitors bounce
 * to '/' before the redirect can name anything.
 */
export const Route = createFileRoute('/terrain')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
    throw redirect({ to: '/terrain/map' });
  },
  component: () => null,
});
