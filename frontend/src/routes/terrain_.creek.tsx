import { createFileRoute, redirect } from '@tanstack/react-router';
import { CreekView } from '../features/creek/CreekView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/creek — data flow drawn as a place: code files on the left bank,
 * vault collections on the right, ribbons of flow between them.
 *
 * It lives under /terrain beside the pond, the map's own two halves finally
 * both drawn: the map sketches the creek as a hint, this room draws it in
 * full, reading GET /api/creek (routes/creek.py — built in parallel).
 *
 * Un-nested (the `terrain_.` prefix), same as the other rooms: the map
 * unmounts and this owns the screen, "← Terrain" walks back. Same auth guard
 * as the map and the pond — this names the codebase's own internals, kept out
 * of public view like everything else under /terrain.
 */
export const Route = createFileRoute('/terrain_/creek')({
  // `?journey=<id>` opens the creek in Journey mode on that capture.
  validateSearch: (raw: Record<string, unknown>): { journey?: string } =>
    typeof raw.journey === 'string' && raw.journey ? { journey: raw.journey } : {},
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: CreekRoute,
});

function CreekRoute() {
  useDeactivateFrames();
  return <CreekView />;
}
