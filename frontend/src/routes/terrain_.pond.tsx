import { createFileRoute, redirect } from '@tanstack/react-router';
import { PondView } from '../features/pond/PondView';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /terrain/pond — the journal drawn as a place: every card at its own day and
 * hour, with a thread's line bouncing across the days it touches.
 *
 * It lives under /terrain because the terrain is where the system looks at
 * itself, and this is the other half of the pair the map started: the map draws
 * the CREEK (data moving across the seam between the code and the vault), this
 * draws the POND (where that data comes to rest). Reads routes/pond.py, which
 * queries the `cards` table cardstore.py already mirrors out of the pool.
 *
 * Un-nested (the `terrain_.` prefix), same as the other rooms: the map unmounts
 * and this owns the screen, "← Terrain" walks back. Same auth guard as the map
 * — this one names her journal, so it must never render in public view.
 */
export const Route = createFileRoute('/terrain_/pond')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: PondRoute,
});

function PondRoute() {
  useDeactivateFrames();
  return <PondView />;
}
