import { createFileRoute, redirect } from '@tanstack/react-router';
import { AppsRoom } from '../features/terrain/apps/AppsRoom';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/apps — the site as the apps it is cut into (Journal, Observatory,
 * Finances, Inventory, and Based Foods' kitchen pages), what each is made of,
 * and where they still reach into each other. Read-only; reads /api/apps.
 *
 * Un-nested (the `terrain_.` prefix) like the other rooms: the map unmounts
 * and this owns the screen, "← Rooms" reopens the hallway. Same auth guard as
 * the rest of the terrain — it names the codebase's internals.
 */
export const Route = createFileRoute('/terrain_/apps')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: AppsRoute,
});

function AppsRoute() {
  useDeactivateFrames();
  return <AppsRoom />;
}
